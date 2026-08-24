import { Effect, Fiber, Stream } from "effect";
import { createEngine } from "@wm/engine";
import type {
  Clock,
  Command,
  CommandError,
  CommandResult,
  ConfigSource,
  DomainEvent,
  Engine as EngineApi,
  StateSnapshot,
  WindowId,
} from "@wm/engine";
import { createWebPlatformSim, type SimGroundTruth, type WebPlatformSim } from "./sim/web-platform.ts";
import {
  buildScene,
  drawScene,
  fitViewport,
  hitTestWindow,
  panBy,
  screenToWorld,
  unionFrames,
  zoomAt,
  type Scene,
  type Viewport,
} from "./ui/canvas.ts";
import { createPanels, el } from "./ui/panels.ts";
import {
  ScenarioRecorder,
  ScenarioRunner,
  replayEntries,
  scenarioById,
} from "./ui/scenarios.ts";

// Bootstrap — docs/rewrite/web-renderer.md. Builds a simulated platform world
// (two displays incl. one at negative origin), starts the REAL engine against
// it with an inline config source and the real clock, then mounts the UI.

// ---------------------------------------------------------------------------
// INTEGRATION SEAM
// ---------------------------------------------------------------------------
// mountRendererHost(engine, options?) is the single entry point the future
// real-adapter host needs: it depends ONLY on the frozen @wm/engine public API
// (Engine) plus optional renderer-owned extras. Swapping the sim for the macOS
// adapter later = building `engine` differently; everything below this line
// keeps working (scenario controls simply stay hidden when `sim` is omitted).

export interface RendererHostOptions {
  /** Present only in simulation mode; scenario/injection panels require it. */
  sim?: WebPlatformSim | undefined;
}

export interface RendererHost {
  stop(): void;
  refresh(): Promise<void>;
}

const INITIAL_REFS_KEY_PREFIX = "sim-";

export function mountRendererHost(
  engine: EngineApi,
  options: RendererHostOptions = {},
): RendererHost {
  const sim = options.sim;

  const canvas = document.getElementById("stage");
  if (!(canvas instanceof HTMLCanvasElement)) throw new Error("#stage canvas missing");
  const wrap = document.getElementById("canvas-wrap") ?? canvas.parentElement ?? document.body;

  // --- top bar ---
  const healthBadge = document.getElementById("top-health");
  const pausedBadge = document.getElementById("top-paused");
  const epochLabel = document.getElementById("top-epoch");
  const refreshButton = document.getElementById("top-refresh");

  // --- viewport state ---
  let viewport: Viewport | null = null;
  let latestSnapshot: StateSnapshot | null = null;
  let latestScene: Scene | null = null;
  let selectedWindowId: string | null = null;

  const dpr = (): number => window.devicePixelRatio || 1;

  const resizeCanvas = (): void => {
    const ratio = dpr();
    canvas.width = Math.max(64, Math.floor(wrap.clientWidth * ratio));
    canvas.height = Math.max(64, Math.floor(wrap.clientHeight * ratio));
    canvas.style.width = `${wrap.clientWidth}px`;
    canvas.style.height = `${wrap.clientHeight}px`;
    redraw();
  };

  // --- panels & command plumbing ---

  const recorder = new ScenarioRecorder();

  /**
   * Force a full reconcile + world refresh.
   *
   * ENGINE QUIRK WORKAROUND (upstream note): every layout-mutating command
   * runs `gatedReconcile()` inside its transaction-queue step, and that nested
   * pass submits its own plan unit to the same single-drain queue. The outer
   * step therefore always suspends until the 15 s timeout race fires, and the
   * losing fiber is interrupted while still inside `gatedReconcile` — leaving
   * its `reconciling` flag stuck so ALL later reconciles no-op. Desired state
   * and nested plan writes DO land before the interruption.
   *
   * `engine.start()` re-runs `runReconcile` DIRECTLY (not through the gate),
   * which re-queries snapshots, repairs geometry and republishes epochs — a
   * clean revival. The renderer calls it after every mutating batch. Cost: one
   * extra idle daemon fiber per call (config stream is `never`, sim emits no
   * events while idle), fine for a debugging tool.
   */
  const revive = async (): Promise<void> => {
    await Effect.runPromise(Effect.either(engine.start())).catch(() => {});
    await refresh();
  };

  const runCommand = async (command: Command): Promise<void> => {
    recorder.record({ kind: "command", command });
    try {
      const result: CommandResult = await Effect.runPromise(engine.execute(command));
      handles.logCommand(command, `ok ${summarizeResult(result)}`);
    } catch (error) {
      const code = (error as Partial<CommandError>)?.code;
      if (code === "timeout") {
        // See `revive`: mutation receipts resolve via the timeout race even
        // though their work applies. Report honestly as deferred.
        handles.logCommand(command, "deferred (applied asynchronously)");
      } else {
        const detail =
          (error as Partial<CommandError>)?.message !== undefined
            ? `${code}: ${(error as Partial<CommandError>).message}`
            : String(error);
        handles.logCommand(command, `error ${detail}`);
      }
    }
    await revive();
  };

  const initialRefs = (): Map<string, string> => {
    const refs = new Map<string, string>();
    if (sim === undefined) return refs;
    sim.windowIds().forEach((id, index) => {
      refs.set(`${INITIAL_REFS_KEY_PREFIX}${index + 1}`, id);
    });
    return refs;
  };

  const makeScenarioContext = () => ({
    sim: sim as WebPlatformSim,
    execute: async (command: Command) => {
      try {
        await Effect.runPromise(engine.execute(command));
        return { ok: true as const, detail: "ok" };
      } catch (error) {
        const code = (error as Partial<CommandError>)?.code;
        if (code === "timeout") return { ok: true as const, detail: "deferred" };
        return { ok: false as const, detail: String(code ?? "failed") };
      }
    },
  });

  const runScenarioById = (scenarioId: string): void => {
    const scenario = scenarioById(scenarioId);
    if (scenario === undefined || sim === undefined) return;
    recorder.record({ kind: "scenario", scenarioId });
    void (async () => {
      const runner = new ScenarioRunner(makeScenarioContext(), initialRefs());
      await runner.run(scenario);
      await revive();
    })();
  };

  const replayRecording = (name: string): void => {
    if (sim === undefined) return;
    const entries = ScenarioRecorder.load(name);
    if (entries === null || entries.length === 0) return;
    void (async () => {
      await replayEntries(entries, () => new ScenarioRunner(makeScenarioContext(), initialRefs()));
      await revive();
    })();
  };

  const handles = createPanels({
    engine,
    getSnapshot: () => latestSnapshot,
    getGroundTruth: () => (sim !== undefined ? sim.groundTruth() : null),
    runCommand,
    runScenario: runScenarioById,
    replayRecording,
    recorder,
    recordingNames: () => ScenarioRecorder.listNames(),
  });

  // Mount side panels.
  const existingSide = document.getElementById("side");
  existingSide?.remove();
  document.body.append(handles.root);

  // --- drawing ---

  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("2d context unavailable");
  const stage: HTMLCanvasElement = canvas;

  const redraw = (): void => {
    if (latestScene === null) return;
    const ratio = dpr();
    ctx.save();
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawScene(ctx, latestScene, effectiveViewport(), { selectedWindowId });
    ctx.restore();
  };

  const effectiveViewport = (): Viewport => {
    const scene = latestScene;
    if (scene === null) return { x: 0, y: 0, scale: 0.5 };
    if (viewport === null) {
      const bounds = unionFrames(scene.displays.map((d) => d.frame));
      viewport = fitViewport(bounds, stage.width / dpr(), stage.height / dpr(), 48);
    }
    return viewport;
  };

  async function refresh(): Promise<void> {
    const snapshot = await Effect.runPromise(engine.state());
    const changed = latestSnapshot === null || JSON.stringify(snapshot) !== JSON.stringify(latestSnapshot);
    latestSnapshot = snapshot;

    const groundTruth: SimGroundTruth | null = sim !== undefined ? sim.groundTruth() : null;
    latestScene = buildScene(snapshot, {
      focusedWindowId: groundTruth?.focusedWindowId ?? null,
    });

    handles.updateInspector(snapshot, groundTruth);
    handles.populateSelects(snapshot);

    // Redraw on committed-state change only. NOTE: the spec names the
    // reconciliation epoch as the change signal, but this engine build can
    // lose the epoch bump when a command's nested reconcile is interrupted by
    // its own transaction timeout race — so the renderer diffs snapshots
    // instead (still strictly change-triggered, never continuous).
    if (changed) redraw();

    updateTopBar(snapshot);
  }

  function updateTopBar(snapshot: StateSnapshot): void {
    if (healthBadge !== null) {
      healthBadge.textContent = snapshot.health;
      healthBadge.className = `badge h-${snapshot.health}`;
    }
    if (pausedBadge !== null) {
      pausedBadge.textContent = snapshot.paused ? "PAUSED" : "running";
      pausedBadge.className = snapshot.paused ? "badge paused" : "badge";
    }
    if (epochLabel !== null) epochLabel.textContent = `epoch ${snapshot.epoch}`;
  }

  refreshButton?.addEventListener("click", () => {
    void refresh();
  });

  // --- pointer / wheel interaction (viewport gestures don't touch the engine) ---

  let dragging: { sx: number; sy: number; origin: Viewport; movedPx: number } | null = null;

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    viewport = zoomAt(
      effectiveViewport(),
      event.deltaY < 0 ? 1.15 : 1 / 1.15,
      (event.clientX - rect.left) * dpr(),
      (event.clientY - rect.top) * dpr(),
    );
    redraw();
  });

  canvas.addEventListener("pointerdown", (event) => {
    const vp = effectiveViewport();
    dragging = { sx: event.clientX, sy: event.clientY, origin: { ...vp }, movedPx: 0 };
    canvas.setPointerCapture(event.pointerId);
  });

  canvas.addEventListener("pointermove", (event) => {
    if (dragging === null) return;
    const dx = (event.clientX - dragging.sx) * dpr();
    const dy = (event.clientY - dragging.sy) * dpr();
    dragging.movedPx = Math.max(dragging.movedPx, Math.hypot(dx, dy));
    viewport = {
      ...dragging.origin,
      x: dragging.origin.x - dx / dragging.origin.scale,
      y: dragging.origin.y - dy / dragging.origin.scale,
    };
    redraw();
  });

  canvas.addEventListener("pointerup", (event) => {
    const gesture = dragging;
    dragging = null;
    canvas.releasePointerCapture(event.pointerId);
    // Click without drag: select topmost window under the cursor.
    if (gesture !== null && gesture.movedPx < 3 && latestScene !== null) {
      const rect = canvas.getBoundingClientRect();
      const vp = effectiveViewport();
      const worldPoint = screenToWorld(
        vp,
        (event.clientX - rect.left) * dpr(),
        (event.clientY - rect.top) * dpr(),
      );
      selectedWindowId = hitTestWindow(latestScene, worldPoint);
      redraw();
    }
  });

  window.addEventListener("resize", resizeCanvas);

  // --- engine event subscription ---

  const onDomainEvent = (_event: DomainEvent): void => {
    handles.logEvent(_event);
    // Any domain event may reflect a committed change the epoch missed —
    // refresh pulls state and redraws only if the snapshot actually changed.
    void refresh();
  };

  const eventFiber = Stream.runForEach(engine.events(), (event) =>
    Effect.sync(() => onDomainEvent(event)),
  ).pipe(Effect.runFork);

  resizeCanvas();

  return {
    stop(): void {
      Effect.runFork(Fiber.interrupt(eventFiber));
      void Effect.runPromise(engine.stop()).catch(() => {});
    },
    refresh,
  };
}

function summarizeResult(result: CommandResult): string {
  switch (result.type) {
    case "state":
      return `state@${result.snapshot.epoch}`;
    case "windows":
      return `${result.windows.length} windows`;
    case "displays":
      return `${result.displays.length} displays`;
    case "workspaces":
      return `${result.workspaces.length} workspaces`;
    case "configChecked":
      return result.valid ? "config valid" : `invalid: ${result.issues[0] ?? "?"}`;
    default:
      return result.type;
  }
}

// ---------------------------------------------------------------------------
// Simulation-mode bootstrap (sim adapter + inline config + real clock)
// ---------------------------------------------------------------------------

const RENDERER_CONFIG = {
  defaults: { gap: 8 },
  workspaces: [
    { name: "1", mode: "bsp" as const },
    { name: "2", mode: "bsp" as const },
  ],
};

const inlineConfigSource: ConfigSource = {
  load: () => Effect.succeed(RENDERER_CONFIG),
  changes: () => Stream.never,
};

/**
 * Renderer clock: real wall-clock `now()` with VIRTUAL instantaneous sleep.
 *
 * Rationale: the engine's transaction queue races every unit against
 * clock.sleep(TIMEOUT_MS); with real timers, a layout-mutating command (whose
 * applyMutation nests a reconcile plan submission inside the queue) always
 * loses that race, the losing fiber is interrupted mid-reconcile, and
 * subsequent reconciles wedge. Instantaneous virtual sleep — the same regime
 * the engine's own headless suite uses — lets nested units settle
 * synchronously and deterministically. The simulated platform is READ-driven
 * (animations advance per settle read, never per millisecond), so zero-latency
 * sleeps lose nothing. Production hosts should inject real `Effect.sleep`.
 */
const makeRendererClock = (): Clock => {
  let virtualNow = Date.now();
  return {
    now: () => Date.now(),
    sleep: (millis: number) =>
      Effect.sync(() => {
        virtualNow += millis;
      }),
  };
};

const realClock: Clock = makeRendererClock();

function seedWorld(sim: WebPlatformSim): readonly WindowId[] {
  // Primary display windows. The engine's assign-new-windows rule quarantines
  // while a workspace tree is EMPTY (preflight needs a sibling), so bootstrap
  // seeds membership through moveWindowToWorkspace commands after start()
  // (see bootstrap).
  //
  // NOTE: no fixed-size window here ON PURPOSE — an unassigned fixed-size
  // window makes every layout pass fail-rollback-churn (its preflight write
  // hard-rejects), which is exactly what the "Fixed-size window appears"
  // scenario demonstrates in isolation.
  const normal: WindowId[] = [];
  normal.push(sim.addWindow({ title: "Editor", bundleId: "com.sim.editor", width: 900, height: 600 }));
  normal.push(sim.addWindow({ title: "Terminal", bundleId: "com.sim.term", width: 700, height: 460 }));
  sim.addWindow({ title: "Palette", bundleId: "com.sim.editor", width: 300, height: 220 });
  return normal;
}

/** Drive a command and swallow expected failures (bootstrap convenience). */
const runQuietly = async (engine: EngineApi, command: Command): Promise<void> => {
  await Effect.runPromise(Effect.either(engine.execute(command))).catch(() => {});
};

export interface Bootstrap extends RendererHost {
  sim: WebPlatformSim;
  engine: EngineApi;
}

/** Build sim world + engine and mount the UI. Browser entry point. */
export async function bootstrap(seed = 1337): Promise<Bootstrap> {
  const sim = createWebPlatformSim({ seed });
  const seedable = seedWorld(sim);

  const engine = await Effect.runPromise(
    createEngine({ adapter: sim.adapter, configSource: inlineConfigSource, clock: realClock }),
  );
  await Effect.runPromise(engine.start());

  // Seed workspace "1" membership via the CommandBus (see seedWorld note).
  // Each move self-applies desired state; afterwards one direct start() pass
  // (see `revive` in mountRendererHost) reconciles geometry cleanly.
  for (const id of seedable) {
    await runQuietly(engine, { type: "moveWindowToWorkspace", windowId: id, workspace: "1" });
  }
  await runQuietly(engine, { type: "focusWorkspace", name: "1" });
  await Effect.runPromise(Effect.either(engine.start())).catch(() => {});

  const host = mountRendererHost(engine, { sim });
  return {
    sim,
    engine,
    stop: host.stop,
    refresh: host.refresh,
  };
}

// Auto-mount in the browser; harmless no-op under node/vitest (no document).
if (typeof document !== "undefined") {
  void bootstrap().catch((error) => {
    console.error("renderer bootstrap failed", error);
    const fallback = el("pre", {
      class: "fatal",
      text: `renderer bootstrap failed:\n${String(error)}`,
    });
    document.body.append(fallback);
  });
}
