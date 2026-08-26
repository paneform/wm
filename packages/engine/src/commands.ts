import { Effect, Schema } from "effect";
import type { Clock } from "./platform.ts";
import { Direction } from "./direction.ts";
import {
  Capabilities,
  DisplayObservation,
  Frame,
  WindowObservation,
} from "./schema.ts";
import { EMPTY_TREE_LEAF } from "./constants.ts";
import type { BspNode } from "./world.ts";
import { tiledMembers } from "./layout/bsp.ts";
import type { TransactionQueue, WorkUnit } from "./transactions.ts";
import { classify, type WorkspaceMode, type World } from "./world.ts";

// Command execution layer — docs/rewrite/engine-guide.md §Command execution
// layer + docs/rewrite/domain-schema.md §Wire protocol messages.
// CLI, WebSocket server and renderer ALL call this same layer.
// Queries return last committed state plus pending metadata — queries NEVER
// wait on platform I/O.

// ---------------------------------------------------------------------------
// Error codes (closed union per domain-schema.md)
// ---------------------------------------------------------------------------

export const CommandErrorCode = Schema.Literal(
  "invalid_request",
  "window_not_found",
  "workspace_not_found",
  "window_not_manageable",
  "window_not_controllable",
  "inventory_stale",
  "geometry_rejected",
  "geometry_verification_failed",
  "topology_unstable",
  "paused",
  "queue_full",
  "timeout",
  "config_invalid",
  "internal_error",
);
export type CommandErrorCode = typeof CommandErrorCode.Type;

export class CommandError extends Schema.TaggedError<CommandError>()("CommandError", {
  code: CommandErrorCode,
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const WorkspaceModeSchema = Schema.Literal("bsp", "floating");

const PointStruct = Schema.Struct({ x: Schema.Number, y: Schema.Number });
const SizeStruct = Schema.Struct({ width: Schema.Number, height: Schema.Number });

export const Command = Schema.Union(
  Schema.Struct({ type: Schema.Literal("getState") }),
  Schema.Struct({ type: Schema.Literal("getWindows") }),
  Schema.Struct({ type: Schema.Literal("getWindow"), windowId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("getDisplays") }),
  Schema.Struct({ type: Schema.Literal("getWorkspaces") }),
  Schema.Struct({ type: Schema.Literal("getTransaction"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("probeWindowLimits"), windowId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("focusWindow"), windowId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("setWindowFrame"),
    windowId: Schema.String,
    frame: Frame,
    tolerance: Schema.optional(Schema.Number),
  }),
  Schema.Struct({ type: Schema.Literal("moveWindow"), windowId: Schema.String, point: PointStruct }),
  Schema.Struct({ type: Schema.Literal("resizeWindow"), windowId: Schema.String, size: SizeStruct }),
  Schema.Struct({ type: Schema.Literal("floatWindow"), windowId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tileWindow"), windowId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("manageWindow"), windowId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("unmanageWindow"), windowId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("focusWorkspace"), name: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("moveWindowToWorkspace"),
    windowId: Schema.String,
    workspace: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("moveWorkspaceToDisplay"),
    workspace: Schema.String,
    displayId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("setWorkspaceMode"),
    workspace: Schema.String,
    mode: WorkspaceModeSchema,
  }),
  Schema.Struct({ type: Schema.Literal("retile"), workspace: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("reconcile") }),
  Schema.Struct({ type: Schema.Literal("pause") }),
  Schema.Struct({ type: Schema.Literal("resume") }),
  // skhd hotkey parity (bean wm-pmys): focused/focused-relative mutations the
  // engine resolves against committed observations — the CLI only maps syntax.
  Schema.Struct({ type: Schema.Literal("togglePause") }),
  Schema.Struct({
    type: Schema.Literal("moveFocusedWindowToWorkspace"),
    workspace: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("moveFocusedWorkspaceToNextDisplay") }),
  Schema.Struct({ type: Schema.Literal("focusDirection"), direction: Direction }),
  Schema.Struct({ type: Schema.Literal("moveDirection"), direction: Direction }),
  Schema.Struct({ type: Schema.Literal("validateConfig") }),
  Schema.Struct({
    type: Schema.Literal("reloadConfig"),
    mode: Schema.optional(Schema.Literal("delta", "full")),
  }),
  Schema.Struct({
    type: Schema.Literal("subscribe"),
    topics: Schema.optional(Schema.Array(Schema.String)),
  }),
);
export type Command = typeof Command.Type;

/** Idempotent intents safe to coalesce while pending share a receipt.
 * State-relative commands (togglePause, *Focused*, *Direction) are NEVER
 * coalescable: each press re-resolves the current focus/state, so collapsing
 * two pending presses would drop a toggle or a cycle step. */
export function coalesceKeyFor(command: Command): string | undefined {
  switch (command.type) {
    case "focusWindow":
      return `focus:${command.windowId}`;
    case "focusWorkspace":
      return `focusWs:${command.name}`;
    case "pause":
      return "pause";
    case "resume":
      return "resume";
    default:
      // Repeated geometry/move commands are NOT equivalent — they escalate.
      return undefined;
  }
}

/** Mutations rejected while paused; pause/resume/togglePause/config/queries
 * stay valid (the toggle must work exactly so the engine can be un-paused). */
export function isBlockedWhenPaused(command: Command): boolean {
  switch (command.type) {
    case "focusWindow":
    case "setWindowFrame":
    case "moveWindow":
    case "resizeWindow":
    case "floatWindow":
    case "tileWindow":
    case "retile":
    case "moveWorkspaceToDisplay":
    case "moveFocusedWindowToWorkspace":
    case "moveFocusedWorkspaceToNextDisplay":
    case "focusDirection":
    case "moveDirection":
    case "probeWindowLimits":
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Results & snapshots
// ---------------------------------------------------------------------------

export const ManagedWindowSnapshot = Schema.Struct({
  id: Schema.String,
  pid: Schema.Number,
  bundleId: Schema.optional(Schema.String),
  executablePath: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  classification: Schema.String,
  managed: Schema.Boolean,
  workspace: Schema.NullOr(Schema.String),
  floating: Schema.Boolean,
  parked: Schema.Boolean,
  frame: Frame,
  capabilities: Capabilities,
});
export interface ManagedWindowSnapshot extends Schema.Schema.Type<typeof ManagedWindowSnapshot> {}

export interface BspLeafSnapshot {
  readonly kind: "leaf";
  readonly windowId: string;
}

export interface BspSplitSnapshot {
  readonly kind: "split";
  readonly axis: "vertical" | "horizontal";
  readonly ratio: number;
  readonly first: BspTreeSnapshot;
  readonly second: BspTreeSnapshot;
}

export type BspTreeSnapshot = BspLeafSnapshot | BspSplitSnapshot;

export const BspTreeSnapshotSchema: Schema.Schema<BspTreeSnapshot> = Schema.suspend(() =>
  Schema.Union(
    Schema.Struct({
      kind: Schema.Literal("leaf"),
      windowId: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("split"),
      axis: Schema.Literal("vertical", "horizontal"),
      ratio: Schema.Number,
      first: BspTreeSnapshotSchema,
      second: BspTreeSnapshotSchema,
    }),
  )
);

export const WorkspaceSnapshot = Schema.Struct({
  name: Schema.String,
  mode: WorkspaceModeSchema,
  members: Schema.Array(Schema.String),
  floating: Schema.Array(Schema.String),
  tree: BspTreeSnapshotSchema,
  visibleOnDisplay: Schema.NullOr(Schema.String),
  preferredDisplay: Schema.NullOr(Schema.String),
  pinnedDisplayOverride: Schema.NullOr(Schema.String),
  /** Most recently focused member; omitted when unknown (null). */
  lastFocusedMember: Schema.optional(Schema.NullOr(Schema.String)),
});
export interface WorkspaceSnapshot extends Schema.Schema.Type<typeof WorkspaceSnapshot> {}

export const PendingTransactionSnapshot = Schema.Struct({
  id: Schema.String,
  coalesceKey: Schema.NullOr(Schema.String),
  submittedAt: Schema.Number,
});
export interface PendingTransactionSnapshot
  extends Schema.Schema.Type<typeof PendingTransactionSnapshot>
{}

export const HealthState = Schema.Literal("healthy", "degraded", "recovering", "unhealthy");
export type HealthState = typeof HealthState.Type;

export const StateSnapshot = Schema.Struct({
  epoch: Schema.Number,
  paused: Schema.Boolean,
  health: HealthState,
  focusedWorkspace: Schema.NullOr(Schema.String),
  /** Effective engine window focus (intent or observed); optional for wire compat. */
  focusedWindow: Schema.optional(Schema.NullOr(Schema.String)),
  topology: Schema.Array(DisplayObservation),
  windows: Schema.Array(ManagedWindowSnapshot),
  workspaces: Schema.Array(WorkspaceSnapshot),
  pendingTransactions: Schema.Array(PendingTransactionSnapshot),
});
export interface StateSnapshot extends Schema.Schema.Type<typeof StateSnapshot> {}

export const CommandResult = Schema.Union(
  Schema.Struct({ type: Schema.Literal("state"), snapshot: StateSnapshot }),
  Schema.Struct({ type: Schema.Literal("windows"), windows: Schema.Array(WindowObservation) }),
  Schema.Struct({
    type: Schema.Literal("window"),
    window: Schema.NullOr(WindowObservation),
  }),
  Schema.Struct({ type: Schema.Literal("displays"), displays: Schema.Array(DisplayObservation) }),
  Schema.Struct({ type: Schema.Literal("workspaces"), workspaces: Schema.Array(WorkspaceSnapshot) }),
  Schema.Struct({
    type: Schema.Literal("transaction"),
    id: Schema.String,
    status: Schema.NullOr(Schema.String),
    appliedSteps: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("subscribed"),
    topics: Schema.Array(Schema.String),
    latestSeq: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal("configChecked"),
    valid: Schema.Boolean,
    issues: Schema.Array(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("ok"), detail: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("windowLimitsProbe"),
    windowId: Schema.String,
    identity: Schema.String,
    target: Schema.Union(
      Schema.Struct({
        mode: Schema.Literal("parked"),
        hostDisplayId: Schema.String,
        corner: Schema.Literal("bottomLeft", "bottomRight", "topLeft", "topRight"),
        retainedVisibility: Schema.Struct({ horizontal: Schema.Number, vertical: Schema.Number }),
        positionCorrection: Schema.Literal("verified", "clamped"),
      }),
    ),
    phases: Schema.Struct({
      capability: Schema.Literal("verified"),
      parking: Schema.Literal("adoptedVerified"),
      minimumSize: Schema.Literal("verified"),
      maximumSize: Schema.Literal("verified"),
      restore: Schema.Literal("verifiedExact"),
    }),
    capability: Schema.Struct({
      source: Schema.Literal("parkedBehavioralProbe"),
      movable: Schema.Literal("supported"),
      resizable: Schema.Literal("supported"),
    }),
    positionDiagnostics: Schema.Array(Schema.Struct({
      sample: Schema.Literal("capabilityWidth", "capabilityHeight", "minWidth", "minHeight", "maxWidth", "maxHeight"),
      correction: Schema.Literal("verified", "clamped"),
      requestedIdealPoint: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
      observedPoint: Schema.Struct({ x: Schema.Number, y: Schema.Number }),
      idealRetainedVisibility: Schema.Struct({ horizontal: Schema.Number, vertical: Schema.Number }),
      actualRetainedVisibility: Schema.Struct({ horizontal: Schema.Number, vertical: Schema.Number }),
    })),
    originalFrame: Frame,
    restoredFrame: Frame,
    restoreStatus: Schema.Literal("verifiedExact"),
    testedRanges: Schema.Struct({
      width: Schema.Struct({ min: Schema.Number, max: Schema.Number }),
      height: Schema.Struct({ min: Schema.Number, max: Schema.Number }),
    }),
    findings: Schema.Struct({
      minWidth: Schema.Union(
        Schema.Struct({ kind: Schema.Literal("exact"), value: Schema.Number }),
        Schema.Struct({ kind: Schema.Literal("noClampDownTo"), value: Schema.Number }),
      ),
      minHeight: Schema.Union(
        Schema.Struct({ kind: Schema.Literal("exact"), value: Schema.Number }),
        Schema.Struct({ kind: Schema.Literal("noClampDownTo"), value: Schema.Number }),
      ),
      maxWidth: Schema.Union(
        Schema.Struct({ kind: Schema.Literal("exact"), value: Schema.Number }),
        Schema.Struct({ kind: Schema.Literal("noClampThrough"), value: Schema.Number }),
      ),
      maxHeight: Schema.Union(
        Schema.Struct({ kind: Schema.Literal("exact"), value: Schema.Number }),
        Schema.Struct({ kind: Schema.Literal("noClampThrough"), value: Schema.Number }),
      ),
    }),
    profileUpdated: Schema.Boolean,
  }),
);
export type CommandResult = typeof CommandResult.Type;

/**
 * Committed-state projection: user-facing view of topology, managed windows,
 * workspaces, focus, health and pending transaction metadata.
 */
export function projectSnapshot(
  world: World,
  health: HealthState,
  pending: readonly PendingTransactionSnapshot[],
): StateSnapshot {
  const memberToWorkspace = new Map<string, { workspace: string; floating: boolean }>();
  for (const ws of world.workspaces.values()) {
    for (const id of tiledMembers(ws.tree)) {
      if (id !== EMPTY_TREE_LEAF) memberToWorkspace.set(id, { workspace: ws.name, floating: false });
    }
    for (const id of ws.floating) {
      memberToWorkspace.set(id, { workspace: ws.name, floating: true });
    }
  }

  const windows: ManagedWindowSnapshot[] = [...world.windows.values()].map((obs) => {
    const membership = memberToWorkspace.get(obs.id);
    const parked = [...world.workspaces.values()].some((ws) => ws.parkedFrames.has(obs.id));
    return {
      id: obs.id,
      pid: obs.pid,
      ...(obs.bundleId !== undefined ? { bundleId: obs.bundleId } : {}),
      ...(obs.executablePath !== undefined ? { executablePath: obs.executablePath } : {}),
      ...(obs.title !== undefined ? { title: obs.title } : {}),
      classification: classify(obs),
      managed: membership !== undefined,
      workspace: membership?.workspace ?? null,
      floating: membership?.floating ?? false,
      parked,
      frame: obs.frame satisfies typeof Frame.Type,
      capabilities: obs.capabilities,
    };
  });

  const workspaces: WorkspaceSnapshot[] = [...world.workspaces.values()].map((ws) => ({
    name: ws.name,
    mode: ws.mode as WorkspaceMode,
    members: tiledMembers(ws.tree).filter((id) => id !== EMPTY_TREE_LEAF),
    floating: [...ws.floating],
    tree: ws.tree as unknown as BspTreeSnapshot,
    visibleOnDisplay: ws.visibleOnDisplay,
    preferredDisplay: ws.preferredDisplay,
    pinnedDisplayOverride: ws.pinnedDisplayOverride,
    ...(ws.lastFocusedMember !== null ? { lastFocusedMember: ws.lastFocusedMember } : {}),
  }));

  return {
    epoch: world.epoch,
    paused: world.paused,
    health,
    focusedWorkspace: world.focusedWorkspace,
    ...(world.focusIntent !== null
      ? { focusedWindow: world.focusIntent.id }
      : (() => {
          for (const obs of world.windows.values()) {
            if (obs.focused) return { focusedWindow: obs.id };
          }
          return {};
        })()),
    topology: world.topology.displays.map((d) => ({ ...d })),
    windows,
    workspaces,
    pendingTransactions: [...pending],
  };
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

export interface CommandBusDeps {
  clock: Clock;
  queue: TransactionQueue;
  /** Committed world accessor — queries read ONLY from this. */
  getWorld(): World;
  health(): HealthState;
  /** Engine-provided mutation application (desired state + rule pass). */
  applyMutation(command: Command): Effect.Effect<CommandResult, CommandError>;
  probeWindowLimits(windowId: string): Effect.Effect<CommandResult, CommandError>;
  validateConfigCandidate(): Effect.Effect<CommandResult, CommandError>;
  reloadConfig(mode: "delta" | "full"): Effect.Effect<CommandResult, CommandError>;
  subscriptionTopics(): readonly string[];
  latestEventSeq(): number;
}

export interface CommandBus {
  execute(command: Command): Effect.Effect<CommandResult, CommandError>;
}

function decodeCommand(raw: unknown): Command {
  return Schema.decodeUnknownSync(Command, { onExcessProperty: "error" })(raw);
}

export function createCommandBus(deps: CommandBusDeps): CommandBus {
  const query = (command: Command): Effect.Effect<CommandResult, CommandError> =>
    Effect.gen(function* () {
      const world = deps.getWorld();
      switch (command.type) {
        case "getState":
          return {
            type: "state",
            snapshot: projectSnapshot(world, deps.health(), []),
          };
        case "getWindows":
          return { type: "windows", windows: [...world.windows.values()].map((w) => ({ ...w })) };
        case "getWindow":
          return { type: "window", window: world.windows.get(command.windowId) ?? null };
        case "getDisplays":
          return { type: "displays", displays: world.topology.displays.map((d) => ({ ...d })) };
        case "getWorkspaces":
          return {
            type: "workspaces",
            workspaces: projectSnapshot(world, deps.health(), []).workspaces,
          };
        case "getTransaction": {
          const history = deps.queue.history().find((r) => r.id === command.id);
          if (history !== undefined) {
            return {
              type: "transaction",
              id: history.id,
              status: history.status,
              appliedSteps: [...history.appliedSteps],
            };
          }
          const pending = deps.queue.pending().find((p) => p.id === command.id);
          return {
            type: "transaction",
            id: command.id,
            status: pending !== undefined ? "pending" : null,
            appliedSteps: [],
          };
        }
        case "validateConfig":
          return yield* deps.validateConfigCandidate();
        case "reloadConfig":
          return yield* deps.reloadConfig(command.mode ?? "full");
        case "subscribe":
          return {
            type: "subscribed",
            topics: [...deps.subscriptionTopics()],
            latestSeq: deps.latestEventSeq(),
          };
        default:
          return yield* mutate(command);
      }
    });

  const mutate = (command: Command): Effect.Effect<CommandResult, CommandError> => {
    const world = deps.getWorld();

    if (isBlockedWhenPaused(command) && world.paused) {
      return Effect.fail(new CommandError({ code: "paused", message: "engine is paused" }));
    }

    const windowId = windowIdOf(command);
    if (windowId !== null && !world.windows.has(windowId)) {
      return Effect.fail(
        new CommandError({
          code: "window_not_found",
          message: `unknown window ${windowId}`,
        }),
      );
    }

    let structuredResult: CommandResult | undefined;
    const unit: WorkUnit = {
      id: `cmd:${deps.clock.now()}:${Math.floor(Math.random() * 1e9).toString(36)}`,
      coalesceKey: command.type === "probeWindowLimits" ? undefined : coalesceKeyFor(command),
      steps: [
        {
          name: command.type,
          run: () => command.type === "probeWindowLimits"
            ? Effect.tap(deps.probeWindowLimits(command.windowId), (result) =>
                Effect.sync(() => { structuredResult = result; }))
            : deps.applyMutation(command),
        },
      ],
    };

    return Effect.flatMap(
      Effect.mapError(deps.queue.submit(unit), mapSubmitError),
      (receipt) =>
        receipt.status === "completed"
          ? structuredResult !== undefined
            ? Effect.succeed(structuredResult)
            : Effect.succeed<CommandResult>({ type: "ok", detail: receipt.id })
          : receipt.status === "timeout"
            ? Effect.fail(
                new CommandError({ code: "timeout", message: "operation timed out" }),
              )
            : Effect.fail(
                new CommandError({
                  code: mapStepCode(receipt.error?.code),
                  message: receipt.error?.message ?? "operation failed",
                }),
              ),
    );
  };

  const execute = (raw: Command): Effect.Effect<CommandResult, CommandError> =>
    Effect.gen(function* () {
      switch (raw.type) {
        case "getState":
        case "getWindows":
        case "getWindow":
        case "getDisplays":
        case "getWorkspaces":
        case "getTransaction":
        case "validateConfig":
        case "reloadConfig":
        case "subscribe":
          return yield* query(raw);
        default:
          return yield* mutate(raw);
      }
    });

  return {
    execute,
  };
}

export { decodeCommand as decodeCommandSync };

function windowIdOf(command: Command): string | null {
  switch (command.type) {
    case "focusWindow":
    case "setWindowFrame":
    case "moveWindow":
    case "resizeWindow":
    case "floatWindow":
    case "tileWindow":
    case "manageWindow":
    case "unmanageWindow":
    case "moveWindowToWorkspace":
    case "probeWindowLimits":
      return command.windowId;
    default:
      return null;
  }
}

function mapSubmitError(error: import("./transactions.ts").SubmitError): CommandError {
  return error.code === "queue_full"
    ? new CommandError({ code: "queue_full", message: "transaction queue is full" })
    : new CommandError({ code: "invalid_request", message: error.detail });
}

export function mapStepCode(code: string | undefined): CommandErrorCode {
  switch (code) {
    case "geometry_rejected":
      return "geometry_rejected";
    case "geometry_verification_failed":
      return "geometry_verification_failed";
    case "rejected":
      return "geometry_rejected";
    case "not_controllable":
      return "window_not_controllable";
    case "stale":
      return "inventory_stale";
    case "window_not_found":
      return "window_not_found";
    case "workspace_not_found":
      return "workspace_not_found";
    case "window_not_manageable":
      return "window_not_manageable";
    case "window_not_controllable":
      return "window_not_controllable";
    case "topology_unstable":
      return "topology_unstable";
    case "inventory_stale":
      return "inventory_stale";
    case "config_invalid":
      return "config_invalid";
    case "internal_error":
      return "internal_error";
    default:
      return "internal_error";
  }
}
