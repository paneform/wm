import type { Command, Frame } from "@wm/engine";
import type { SimPersonality, WebPlatformSim } from "../sim/web-platform.ts";

// Scenario system — docs/rewrite/web-renderer.md §UI sketch + §Implementation
// notes. Scenarios are PURE DATA: scripted edge-case sequences driving the sim
// platform and the engine's command bus. The recorder captures scenario runs,
// manual sim injections and user commands into localStorage; replay rebuilds a
// fresh sim+engine and applies entries sequentially (timestamps ignored), so
// replays are deterministic given equal seeds.

// ---------------------------------------------------------------------------
// Ops
// ---------------------------------------------------------------------------

export type DisplayAlias = "primary" | "secondary" | string;

/** Placeholder prefix substituted with actual window ids at run time. */
const REF_PREFIX = "@w:";

export type ScenarioOp =
  | {
      kind: "addWindow";
      ref: string;
      title?: string | undefined;
      bundleId?: string | undefined;
      display?: DisplayAlias | undefined;
      x?: number | undefined;
      y?: number | undefined;
      width: number;
      height: number;
      personality?: SimPersonality | undefined;
    }
  | { kind: "removeWindow"; ref: string }
  | { kind: "focusWindow"; ref: string }
  | { kind: "replaceIdentity"; ref: string }
  | { kind: "driftWindow"; ref: string; dx: number; dy: number }
  | { kind: "nudgeWindow"; ref: string; frame: Partial<Frame> }
  | { kind: "disconnectDisplay"; display: DisplayAlias }
  | {
      kind: "connectDisplay";
      id: string;
      frame: Frame;
      workArea: Frame;
      scale: number;
      primary: boolean;
    }
  | { kind: "updateWorkArea"; display: DisplayAlias; workArea: Frame }
  | { kind: "setVisibility"; display: DisplayAlias; horizontal: number; vertical: number }
  /** Raw command template; "@w:<ref>" placeholders resolve to window ids. */
  | { kind: "command"; command: Command };

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly ops: readonly ScenarioOp[];
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface ScenarioExecuteOutcome {
  ok: boolean;
  detail: string;
}

export interface ScenarioContext {
  sim: WebPlatformSim;
  /** Runs through engine.execute(); must never throw — report outcomes. */
  execute(command: Command): Promise<ScenarioExecuteOutcome>;
}

export interface ScenarioRunResult {
  scenarioId: string;
  executedOps: number;
  errors: readonly string[];
}

export class ScenarioRunner {
  private readonly refs = new Map<string, string>();

  constructor(
    private readonly ctx: ScenarioContext,
    initialRefs: ReadonlyMap<string, string> = new Map(),
  ) {
    for (const [ref, id] of initialRefs) this.refs.set(ref, id);
  }

  resolve(ref: string): string | undefined {
    return this.refs.get(ref);
  }

  async run(scenario: Scenario): Promise<ScenarioRunResult> {
    const errors: string[] = [];
    let executed = 0;
    for (const op of scenario.ops) {
      try {
        await this.apply(op);
        executed += 1;
      } catch (error) {
        errors.push(`${op.kind}: ${String(error)}`);
      }
    }
    return { scenarioId: scenario.id, executedOps: executed, errors };
  }

  async apply(op: ScenarioOp): Promise<void> {
    switch (op.kind) {
      case "addWindow": {
        this.refs.set(
          op.ref,
          this.ctx.sim.addWindow({
            ref: op.ref,
            title: op.title,
            bundleId: op.bundleId,
            width: op.width,
            height: op.height,
            x: op.x,
            y: op.y,
            personality: op.personality,
            ...(op.display !== undefined ? { displayId: this.displayId(op.display) } : {}),
          }),
        );
        return;
      }
      case "removeWindow": {
        const id = this.require(op.ref);
        this.ctx.sim.removeWindow(id);
        return;
      }
      case "focusWindow":
        this.ctx.sim.focusWindowExternal(this.require(op.ref));
        return;
      case "replaceIdentity":
        this.ctx.sim.scheduleIdentityReplacement(this.require(op.ref));
        return;
      case "driftWindow": {
        const id = this.require(op.ref);
        this.ctx.sim.driftWindow(id, op.dx, op.dy);
        return;
      }
      case "nudgeWindow": {
        const id = this.require(op.ref);
        this.ctx.sim.nudgeWindow(id, op.frame);
        return;
      }
      case "disconnectDisplay":
        this.ctx.sim.disconnectDisplay(this.displayId(op.display));
        return;
      case "connectDisplay":
        this.ctx.sim.connectDisplay({
          id: op.id,
          frame: op.frame,
          workArea: op.workArea,
          scale: op.scale,
          primary: op.primary,
        });
        return;
      case "updateWorkArea":
        this.ctx.sim.updateWorkArea(this.displayId(op.display), op.workArea);
        return;
      case "setVisibility":
        this.ctx.sim.setVisibilityLimits(this.displayId(op.display), {
          horizontal: op.horizontal,
          vertical: op.vertical,
        });
        return;
      case "command":
        await this.ctx.execute(this.substitute(op.command));
        return;
    }
  }

  private require(ref: string): string {
    const id = this.refs.get(ref);
    if (id === undefined) throw new Error(`unknown scenario window ref "${ref}"`);
    return id;
  }

  private displayId(alias: DisplayAlias): string {
    if (alias === "primary") {
      return this.ctx.sim.displays().find((d) => d.primary)?.id ?? alias;
    }
    if (alias === "secondary") {
      return this.ctx.sim.displays().find((d) => !d.primary)?.id ?? alias;
    }
    return alias;
  }

  /** Deep-substitute "@w:<ref>" strings inside a command template. */
  private substitute<T>(value: T): T {
    if (typeof value === "string") {
      if (!value.startsWith(REF_PREFIX)) return value;
      return this.require(value.slice(REF_PREFIX.length)) as unknown as T;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.substitute(item)) as unknown as T;
    }
    if (value !== null && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) out[key] = this.substitute(inner);
      return out as unknown as T;
    }
    return value;
  }
}

// ---------------------------------------------------------------------------
// Recorder — event/command capture + localStorage persistence + replay
// ---------------------------------------------------------------------------

export type RecordedEntry =
  | { t: number; kind: "scenario"; scenarioId: string }
  | { t: number; kind: "op"; op: ScenarioOp }
  | { t: number; kind: "command"; command: Command };

/** A recorded entry without its timestamp — what callers push. */
export type RecordableEntry =
  | { kind: "scenario"; scenarioId: string }
  | { kind: "op"; op: ScenarioOp }
  | { kind: "command"; command: Command };

export const RECORDING_STORE_KEY = "wm.renderer.recordings.v1";

export class ScenarioRecorder {
  private recordingSince: number | null = null;
  private captured: RecordedEntry[] = [];

  start(): void {
    this.recordingSince = Date.now();
    this.captured = [];
  }

  stop(): RecordedEntry[] {
    this.recordingSince = null;
    return [...this.captured];
  }

  get isRecording(): boolean {
    return this.recordingSince !== null;
  }

  get entries(): readonly RecordedEntry[] {
    return this.captured;
  }

  private stamp(): number {
    return this.recordingSince === null ? 0 : Date.now() - this.recordingSince;
  }

  record(entry: RecordableEntry): void {
    if (this.recordingSince === null) return;
    this.captured.push({ ...entry, t: this.stamp() } as RecordedEntry);
  }

  save(name: string): void {
    if (typeof localStorage === "undefined") return;
    const all = loadRecordings();
    all[name] = this.captured;
    localStorage.setItem(RECORDING_STORE_KEY, JSON.stringify(all));
  }

  static load(name: string): RecordedEntry[] | null {
    const all = loadRecordings();
    return all[name] ?? null;
  }

  static listNames(): string[] {
    return Object.keys(loadRecordings());
  }
}

function loadRecordings(): Record<string, RecordedEntry[]> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(RECORDING_STORE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, RecordedEntry[]>)
      : {};
  } catch {
    return {};
  }
}

/** Deterministic replay: apply recorded entries sequentially against a fresh runner. */
export async function replayEntries(
  entries: readonly RecordedEntry[],
  makeRunner: () => ScenarioRunner,
): Promise<ScenarioRunResult[]> {
  const results: ScenarioRunResult[] = [];
  let runner: ScenarioRunner | null = null;
  const scenarios = new Map<string, Scenario>(SCENARIOS.map((s) => [s.id, s]));
  for (const entry of entries) {
    if (entry.kind === "scenario") {
      runner = makeRunner();
      const scenario = scenarios.get(entry.scenarioId);
      if (scenario !== undefined) {
        results.push(await runner.run(scenario));
      }
      continue;
    }
    if (runner === null) runner = makeRunner();
    const target = runner;
    if (entry.kind === "op") {
      await target.apply(entry.op);
    } else {
      await target.apply({ kind: "command", command: entry.command });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Built-in scenarios (docs/rewrite/testing-guide.md §Fake platform behaviors)
// ---------------------------------------------------------------------------

const SECONDARY_CONNECT = {
  kind: "connectDisplay",
  id: "display:sim-secondary",
  frame: { x: -1920, y: 0, width: 1920, height: 1080 },
  workArea: { x: -1920, y: 38, width: 1920, height: 1042 },
  scale: 1,
  primary: false,
} as const;

export const SCENARIOS: readonly Scenario[] = [
  {
    id: "fixed-size-appears",
    title: "Fixed-size window appears",
    description:
      "A System-Settings-like fixed-size window shows up; preflight verification must quarantine it instead of inserting it into the BSP tree.",
    ops: [
      {
        kind: "addWindow",
        ref: "fixed",
        title: "Settings (fixed size)",
        bundleId: "com.apple.settings",
        width: 640,
        height: 480,
        personality: { kind: "fixedSize" },
      },
    ],
  },
  {
    id: "rejects-below-minwidth",
    title: "App rejects below minWidth",
    description:
      "Window refuses widths below 800 pt; repeated clamped writes should promote a learned min-width constraint (evidence-gated).",
    ops: [
      {
        kind: "addWindow",
        ref: "clamper",
        title: "Clamper (minWidth 800)",
        bundleId: "sim.clamper",
        width: 900,
        height: 500,
        personality: { kind: "minMaxClamp", constraints: { minWidth: 800, minHeight: 300 } },
      },
      { kind: "command", command: { type: "resizeWindow", windowId: "@w:clamper", size: { width: 500, height: 400 } } },
      { kind: "command", command: { type: "retile" } },
    ],
  },
  {
    id: "disconnect-second-display",
    title: "Disconnect second display",
    description:
      "The negative-origin secondary display vanishes; stranded workspaces must migrate and parked corners re-plan.",
    ops: [{ kind: "disconnectDisplay", display: "secondary" }],
  },
  {
    id: "topology-churn",
    title: "Topology churn (contradictory snapshots)",
    description:
      "Work area shifts (contradictory intermediate snapshot), display disconnects, then reconnects — exercises topology migration under churn.",
    ops: [
      { kind: "addWindow", ref: "churn", title: "Churn victim", width: 700, height: 450 },
      { kind: "updateWorkArea", display: "secondary", workArea: { x: -1920, y: 38, width: 1200, height: 1042 } },
      { kind: "disconnectDisplay", display: "secondary" },
      SECONDARY_CONNECT,
      { kind: "command", command: { type: "reconcile" } },
    ],
  },
  {
    id: "drift-offscreen",
    title: "Window drifts offscreen",
    description:
      "An app drags its own window toward the void; recover-lost-windows must pull it back through its workspace layout.",
    ops: [
      { kind: "addWindow", ref: "drifter", title: "Drifter", width: 600, height: 400 },
      { kind: "driftWindow", ref: "drifter", dx: 900, dy: 0 },
      { kind: "driftWindow", ref: "drifter", dx: 900, dy: 300 },
      { kind: "command", command: { type: "reconcile" } },
    ],
  },
  {
    id: "identity-replacement",
    title: "Identity replacement",
    description:
      "The backing element is swapped behind the same handle mid-flight; writes must abort stale instead of mutating the replacement.",
    ops: [
      { kind: "addWindow", ref: "shapeshifter", title: "Shapeshifter", width: 500, height: 350 },
      { kind: "replaceIdentity", ref: "shapeshifter" },
      { kind: "command", command: { type: "retile" } },
    ],
  },
  {
    id: "reanchoring-resize",
    title: "Reanchoring app resize",
    description:
      "This app keeps its center when resized, so size-only writes end mispositioned; the convergedSizePositionSize ladder rung must converge.",
    ops: [
      {
        kind: "addWindow",
        ref: "anchored",
        title: "Reanchorer",
        width: 520,
        height: 380,
        personality: { kind: "reanchoring", anchor: "center" },
      },
      { kind: "command", command: { type: "resizeWindow", windowId: "@w:anchored", size: { width: 800, height: 600 } } },
    ],
  },
  {
    id: "animated-settling",
    title: "Animated settling",
    description:
      "One window settles quickly (exact outcome); a slow one exhausts the budget mid-animation and is reported progressing — never clobbered.",
    ops: [
      { kind: "addWindow", ref: "fast", title: "Fast animator", width: 500, height: 360, personality: { kind: "animated" } },
      { kind: "addWindow", ref: "slow", title: "Slow animator", width: 500, height: 360, personality: { kind: "slowAnimated" } },
      { kind: "command", command: { type: "moveWindow", windowId: "@w:fast", point: { x: 300, y: 300 } } },
      { kind: "command", command: { type: "moveWindow", windowId: "@w:slow", point: { x: 400, y: 400 } } },
    ],
  },
  {
    id: "unmovable-window",
    title: "Unmovable window",
    description:
      "AX reports movable=false and nudges do nothing; the engine must leave it unmanaged/inconclusive rather than fight it.",
    ops: [
      {
        kind: "addWindow",
        ref: "statue",
        title: "Statue (unmovable)",
        width: 420,
        height: 300,
        personality: { kind: "unmovable" },
      },
    ],
  },
  {
    id: "workspaces-park-reveal",
    title: "Park & reveal across workspaces",
    description:
      "Moves a window to workspace 2 and focuses it; workspace 1 parks its members into offscreen corner slivers (~1×52 pt visible).",
    ops: [
      { kind: "command", command: { type: "moveWindowToWorkspace", windowId: "@w:sim-1", workspace: "2" } },
      { kind: "command", command: { type: "focusWorkspace", name: "2" } },
      { kind: "command", command: { type: "reconcile" } },
    ],
  },
];

export const scenarioById = (id: string): Scenario | undefined =>
  SCENARIOS.find((s) => s.id === id);
