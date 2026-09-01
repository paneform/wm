import { Effect, Fiber, Stream } from "effect";
import type {
  Command,
  CommandError,
  CommandResult,
  DomainEvent,
  Engine as EngineApi,
  StateSnapshot,
} from "@paneform/layout";
import type { SimGroundTruth, WebPlatformSim } from "./sim/web-platform.js";
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
} from "./ui/canvas.js";
import { createPanels } from "./ui/panels.js";
import { ScenarioRecorder, ScenarioRunner, replayEntries, scenarioById } from "./ui/scenarios.js";

export interface LayoutRendererOptions {
  /** Present only in simulation mode; scenario/injection panels require it. */
  sim?: WebPlatformSim | undefined;
  /** Exposes engine mutation controls. Disabled for existing engines by default. */
  enableCommands?: boolean;
}

export interface LayoutRenderer {
  stop(): void;
  refresh(): Promise<void>;
}

const INITIAL_REFS_KEY_PREFIX = "sim-";
const activeRenderers = new WeakMap<HTMLElement, LayoutRenderer>();

export function mountLayoutRenderer(
  container: HTMLElement,
  engine: EngineApi,
  options: LayoutRendererOptions = {},
): LayoutRenderer {
  activeRenderers.get(container)?.stop();
  const sim = options.sim;
  const view = container.ownerDocument.defaultView;
  if (view === null) throw new Error("renderer container is not attached to a window");
  const { canvas, wrap, healthBadge, pausedBadge, epochLabel, refreshButton } =
    createRendererShell(container);

  // --- viewport state ---
  let viewport: Viewport | null = null;
  let latestSnapshot: StateSnapshot | null = null;
  let latestScene: Scene | null = null;
  let latestRenderSignature: string | null = null;
  let selectedWindowId: string | null = null;

  const dpr = (): number => view.devicePixelRatio || 1;
  let backingWidth = 0;
  let backingHeight = 0;

  const resizeCanvas = (): void => {
    const ratio = dpr();
    const cssWidth = Math.max(64, wrap.clientWidth);
    const cssHeight = Math.max(64, wrap.clientHeight);
    const nextWidth = Math.floor(cssWidth * ratio);
    const nextHeight = Math.floor(cssHeight * ratio);
    if (nextWidth === backingWidth && nextHeight === backingHeight) return;
    backingWidth = nextWidth;
    backingHeight = nextHeight;
    canvas.width = nextWidth;
    canvas.height = nextHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    redraw();
  };

  // --- panels & command plumbing ---

  const recorder = new ScenarioRecorder();

  const reconcileScenario = async (): Promise<void> => {
    await Effect.runPromise(Effect.either(engine.reconcile())).catch(() => {});
    await requestRefresh();
  };

  const runCommand = async (command: Command): Promise<void> => {
    recorder.record({ kind: "command", command });
    try {
      const result: CommandResult = await Effect.runPromise(engine.execute(command));
      handles.logCommand(command, `ok ${summarizeResult(result)}`);
    } catch (error) {
      const code = (error as Partial<CommandError>)?.code;
      if (code === "timeout") {
        // Mutation receipts resolve via the timeout race even
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
    await requestRefresh();
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
      await reconcileScenario();
    })();
  };

  const replayRecording = (name: string): void => {
    if (sim === undefined) return;
    const entries = ScenarioRecorder.load(name);
    if (entries === null || entries.length === 0) return;
    void (async () => {
      await replayEntries(entries, () => new ScenarioRunner(makeScenarioContext(), initialRefs()));
      await reconcileScenario();
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
    showCommands: options.enableCommands === true,
    showScenarios: options.enableCommands === true && sim !== undefined,
  });

  container.append(handles.root);

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
    const groundTruth: SimGroundTruth | null = sim !== undefined ? sim.groundTruth() : null;
    const renderSignature = JSON.stringify([snapshot, groundTruth]);
    latestSnapshot = snapshot;
    updateTopBar(snapshot);
    if (renderSignature === latestRenderSignature) return;
    latestRenderSignature = renderSignature;

    latestScene = buildScene(snapshot, {
      focusedWindowId: groundTruth?.focusedWindowId ?? null,
    });

    handles.updateInspector(snapshot, groundTruth);
    handles.populateSelects(snapshot);

    redraw();
  }

  let refreshInFlight: Promise<void> | null = null;
  let refreshPending = false;
  const requestRefresh = (): Promise<void> => {
    refreshPending = true;
    if (refreshInFlight !== null) return refreshInFlight;
    const pending = (async () => {
      while (refreshPending) {
        refreshPending = false;
        await refresh();
      }
    })().finally(() => {
      if (refreshInFlight !== pending) return;
      refreshInFlight = null;
      if (refreshPending) return requestRefresh();
    });
    refreshInFlight = pending;
    return pending;
  };

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
      event.clientX - rect.left,
      event.clientY - rect.top,
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
    const dx = event.clientX - dragging.sx;
    const dy = event.clientY - dragging.sy;
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
      const worldPoint = screenToWorld(vp, event.clientX - rect.left, event.clientY - rect.top);
      selectedWindowId = hitTestWindow(latestScene, worldPoint);
      redraw();
    }
  });

  const resizeObserver = new view.ResizeObserver(resizeCanvas);
  resizeObserver.observe(wrap);

  // --- engine event subscription ---

  const onDomainEvent = (_event: DomainEvent): void => {
    handles.logEvent(_event);
    // Any domain event may reflect a committed change the epoch missed —
    // refresh pulls state and redraws only if the snapshot actually changed.
    void requestRefresh();
  };

  const eventFiber = Stream.runForEach(engine.events(), (event) =>
    Effect.sync(() => onDomainEvent(event)),
  ).pipe(Effect.runFork);

  resizeCanvas();

  let stopped = false;
  const renderer: LayoutRenderer = {
    stop(): void {
      if (stopped) return;
      stopped = true;
      Effect.runFork(Fiber.interrupt(eventFiber));
      resizeObserver.disconnect();
      if (activeRenderers.get(container) === renderer) {
        activeRenderers.delete(container);
        container.replaceChildren();
        container.classList.remove("paneform-layout-browser");
      }
    },
    refresh,
  };
  activeRenderers.set(container, renderer);
  return renderer;
}

interface RendererShell {
  canvas: HTMLCanvasElement;
  wrap: HTMLElement;
  healthBadge: HTMLElement;
  pausedBadge: HTMLElement;
  epochLabel: HTMLElement;
  refreshButton: HTMLButtonElement;
}

function createRendererShell(container: HTMLElement): RendererShell {
  const document = container.ownerDocument;
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    attributes: Record<string, string> = {},
  ): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attributes)) {
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    }
    return node;
  };

  const healthBadge = element("span", {
    class: "badge h-healthy",
    id: "top-health",
    text: "starting",
  });
  const pausedBadge = element("span", { class: "badge", id: "top-paused", text: "running" });
  const epochLabel = element("span", { id: "top-epoch", text: "epoch -" });
  const refreshButton = element("button", {
    id: "top-refresh",
    title: "Pull committed state and redraw",
    text: "refresh",
  });
  const topbar = element("header", { id: "topbar" });
  topbar.append(
    element("strong", { text: "paneform layout visualizer" }),
    healthBadge,
    pausedBadge,
    epochLabel,
    element("span", { class: "spacer" }),
    refreshButton,
  );

  const wrap = element("main", { id: "canvas-wrap" });
  const canvas = element("canvas", { id: "stage" });
  wrap.append(
    canvas,
    element("div", {
      id: "hint",
      text: "wheel = zoom · drag = pan · click = select window",
    }),
  );

  container.classList.add("paneform-layout-browser");
  container.replaceChildren(topbar, wrap);
  return { canvas, wrap, healthBadge, pausedBadge, epochLabel, refreshButton };
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
