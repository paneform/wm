import { Effect, Fiber, Schema, Stream } from "effect";
import type { ConfigSource, PlatformAdapter, Clock } from "./platform.ts";
import { TopologyObservation, WindowObservation } from "./schema.ts";
import type {
  DisplayId,
  DisplayObservation,
  Frame,
  GeometryRequest,
  WindowId,
} from "./schema.ts";
import {
  classify,
  type BspNode,
  type ProfileKey,
  type World,
  type WorkspaceState,
} from "./world.ts";
import { EMPTY_TREE_LEAF, PARKING_ACCEPTANCE_PT } from "./constants.ts";
import { withinTolerance } from "./geometry.ts";
import { applyGeometryRequest, type GeometryFailure } from "./geometry-service.ts";
import {
  candidatesFrom,
  contextFingerprint,
  emptyLearningStore,
  effectiveConstraints,
  markCooperation,
  noteExactFrame,
  profileKeyString,
  recordCandidates,
  type LearningStore,
} from "./learn.ts";
import {
  cornerFeasible,
  cornerTarget,
  defaultParkingVisibility,
  findParkingFact,
  withParkingFact,
  CORNER_PRIORITY,
} from "./parking.ts";
import {
  contentRect,
  constraintsResolver,
  firstLeaf,
  insertLeaf,
  isEmptyTree,
  planLayout,
  removeLeaf,
  tiledMembers,
} from "./layout/bsp.ts";
import type { Action } from "./actions.ts";
import { dedupeActions } from "./actions.ts";
import {
  createCommandBus,
  decodeCommandSync,
  projectSnapshot,
  type Command,
  type CommandBus,
  type CommandResult,
  type HealthState,
  type PendingTransactionSnapshot,
  type StateSnapshot,
} from "./commands.ts";
import { CommandError } from "./commands.ts";
import { createEventBus, type DomainEvent, type EventBus } from "./events.ts";
import { RULES } from "./rules/index.ts";
import type { RuleContext, TombstoneRecord } from "./rules/index.ts";
import { isSuppressedWhenPaused } from "./rules/respect-pause.ts";
import {
  createTransactionQueue,
  type TransactionQueue,
  type WorkUnit,
} from "./transactions.ts";
import {
  applyConfigDelta,
  applyConfigFull,
  effectiveSettings,
  globalSettings,
  parseConfigSafe,
  type Config,
} from "./config.ts";

// Engine pipeline — docs/rewrite/engine-guide.md §Pipeline.
// Platform events are HINTS that trigger re-querying snapshots; rules produce
// an Action plan; the transaction executor applies actions via adapter
// primitives with verification; commits bump the World epoch and emit events.

export interface EngineOptions {
  adapter: PlatformAdapter;
  configSource: ConfigSource;
  clock: Clock;
}

export interface Engine {
  start(): Effect.Effect<void>;
  stop(): Effect.Effect<void>;
  execute(command: Command): Effect.Effect<CommandResult, CommandError>;
  state(): Effect.Effect<StateSnapshot>;
  events(): Stream.Stream<DomainEvent>;
  reconcile(): Effect.Effect<void>;
}

interface HealthRef {
  state: HealthState;
  issues: string[];
}

type StepFailure = { code: string; message: string; diagnostic?: string };

const TOMBSTONE_TTL_MS = 5 * 60 * 1000;

export const createEngine = (options: EngineOptions): Effect.Effect<Engine> =>
  Effect.gen(function* () {
    const { adapter, configSource, clock } = options;

    let world: World = {
      topology: { displays: [] },
      windows: new Map(),
      workspaces: new Map([["1", emptyWorkspace("1")]]),
      focusedWorkspace: "1",
      profiles: new Map(),
      parkingFacts: [],
      paused: false,
      epoch: 0,
    };
    let config: Config = {};
    let learning: LearningStore = emptyLearningStore();
    const tombstones = new Map<WindowId, TombstoneRecord>();
    const overrides = { managed: new Set<WindowId>(), unmanaged: new Set<WindowId>() };
    const firstSeen = new Map<WindowId, Frame>();
    const health: HealthRef = { state: "healthy", issues: [] };
    const fibers: Array<Fiber.RuntimeFiber<unknown, unknown>> = [];

    const bus: EventBus = createEventBus();
    const queue: TransactionQueue = createTransactionQueue({
      clock,
      onDiagnostic: () => {},
    });

    const setHealth = (next: HealthState, issue?: string): void => {
      if (issue !== undefined && !health.issues.includes(issue)) health.issues.push(issue);
      health.state = next;
      bus.publish("health", { state: next, issues: [...health.issues] });
    };

    // ------------------------------------------------------------------
    // Observation helpers
    // ------------------------------------------------------------------

    const primaryDisplay = (): DisplayObservation | undefined =>
      world.topology.displays.find((d) => d.primary) ?? world.topology.displays[0];

    const displayOf = (id: DisplayId | null): DisplayObservation | undefined =>
      id === null ? undefined : world.topology.displays.find((d) => d.id === id);

    const workAreaFor = (observation: WindowObservation): Frame => {
      const cx = observation.frame.x + observation.frame.width / 2;
      const cy = observation.frame.y + observation.frame.height / 2;
      const host = world.topology.displays.find(
        (d) =>
          cx >= d.workArea.x &&
          cx < d.workArea.x + d.workArea.width &&
          cy >= d.workArea.y &&
          cy < d.workArea.y + d.workArea.height,
      );
      return host?.workArea ?? primaryDisplay()?.workArea ?? observation.frame;
    };

    const makeCtx = (): RuleContext => ({
      config,
      now: clock.now(),
      tombstones,
      overrides: { managed: overrides.managed, unmanaged: overrides.unmanaged },
      contextFingerprint: contextFingerprint(world.topology),
      settings: (name) => effectiveSettings(config, name),
      globalSettings: () => globalSettings(config),
    });

    // Boundary validation: observations entering the engine are Schema-checked.
    const validatedTopology = (): Effect.Effect<TopologyObservation, string> =>
      Effect.mapError(
        Effect.flatMap(adapter.getTopology(), (raw) =>
          Schema.decodeUnknown(TopologyObservation)(raw),
        ),
        () => "invalid topology observation",
      );

    const validatedWindows = (): Effect.Effect<ReadonlyArray<WindowObservation>, string> =>
      Effect.mapError(
        Effect.flatMap(adapter.getWindows(), (raw) =>
          Schema.decodeUnknown(Schema.Array(WindowObservation))(raw),
        ),
        () => "invalid window observations",
      );

    // ------------------------------------------------------------------
    // Learning integration (evidence-gated)
    // ------------------------------------------------------------------

    const profileKeyOfObs = (observation: WindowObservation): ProfileKey | null => {
      const application = observation.bundleId ?? observation.executablePath;
      if (application === undefined) return null;
      const key: ProfileKey = {
        application,
        role: observation.role,
        contextFingerprint: contextFingerprint(world.topology),
      };
      if (observation.subrole !== undefined) key.subrole = observation.subrole;
      return key;
    };

    const constraintsFor = (observation: WindowObservation) => {
      const key = profileKeyOfObs(observation);
      const learnedProfile =
        key === null ? undefined : world.profiles.get(profileKeyString(key));
      return effectiveConstraints(observation.constraints, learnedProfile?.constraints, observation.frame);
    };

    const syncProfiles = (): void => {
      world = { ...world, profiles: new Map(learning.profiles) };
    };

    const learnFrom = (
      observation: WindowObservation,
      requested: Frame,
      outcome: "exact" | "constrained" | "stableClamp" | "progressing" | "failed",
      observed: Frame,
    ): void => {
      const key = profileKeyOfObs(observation);
      if (key === null) return;
      if (outcome === "exact") {
        // Exact contradiction replaces a learned bound + resets pending.
        const result = noteExactFrame(learning, key, observed, 1);
        learning = result.store;
        if (result.replaced.length > 0) syncProfiles();
        return;
      }
      if (outcome !== "constrained" && outcome !== "stableClamp") return;
      const scan = candidatesFrom({
        outcome,
        requested,
        observed,
        initial: firstSeen.get(observation.id) ?? observation.frame,
        workArea: workAreaFor(observation),
        tolerance: 1,
      });
      if (scan.candidates.length > 0) {
        const result = recordCandidates(learning, key, scan.candidates);
        learning = result.store;
        syncProfiles();
      }
    };

    // ------------------------------------------------------------------
    // Desired-state mutations
    // ------------------------------------------------------------------

    const emptyTreeLeafNode = (): BspNode => ({ kind: "leaf", windowId: EMPTY_TREE_LEAF });

    const ensureWorkspace = (name: string): WorkspaceState => {
      const existing = world.workspaces.get(name);
      if (existing !== undefined) return existing;
      const created: WorkspaceState = {
        name,
        mode: "bsp",
        tree: emptyTreeLeafNode(),
        floating: new Set(),
        visibleOnDisplay:
          (world.focusedWorkspace !== null
            ? world.workspaces.get(world.focusedWorkspace)?.visibleOnDisplay
            : undefined) ??
          primaryDisplay()?.id ??
          null,
        preferredDisplay: null,
        pinnedDisplayOverride: null,
        parkedFrames: new Map(),
        lastFocusedMember: null,
      };
      world = { ...world, workspaces: new Map(world.workspaces).set(name, created) };
      return created;
    };

    const workspaceContaining = (windowId: WindowId): WorkspaceState | undefined =>
      [...world.workspaces.values()].find(
        (ws) => tiledMembers(ws.tree).includes(windowId) || ws.floating.has(windowId),
      );

    const removeFromMembership = (windowId: WindowId, from: WorkspaceState): WorkspaceState => {
      const remaining = tiledMembers(from.tree).filter((id) => id !== windowId);
      let tree = removeLeaf(from.tree, windowId);
      if (tree === null || remaining.length === 0) tree = emptyTreeLeafNode();
      const floating = new Set(from.floating);
      floating.delete(windowId);
      const parkedFrames = new Map(from.parkedFrames);
      parkedFrames.delete(windowId);
      return {
        ...from,
        tree,
        floating,
        parkedFrames,
        lastFocusedMember:
          from.lastFocusedMember === windowId ? null : from.lastFocusedMember,
      };
    };

    const commitWorkspace = (updated: WorkspaceState): void => {
      world = {
        ...world,
        workspaces: new Map(world.workspaces).set(updated.name, updated),
      };
    };

    const insertTiledInto = (
      workspaceName: string,
      windowId: WindowId,
      besideHint?: WindowId | null,
    ): void => {
      const workspace = ensureWorkspace(workspaceName);
      const members = tiledMembers(workspace.tree);
      const beside =
        besideHint !== undefined && besideHint !== null && members.includes(besideHint)
          ? besideHint
          : workspace.lastFocusedMember !== null && members.includes(workspace.lastFocusedMember)
            ? workspace.lastFocusedMember
            : members[0];
      const besideFrame = beside === undefined ? undefined : world.windows.get(beside)?.frame;

      const tree =
        beside === undefined || besideFrame === undefined || isEmptyTree(workspace.tree)
          ? ({ kind: "leaf", windowId } as BspNode)
          : (insertLeaf(workspace.tree, beside, windowId, besideFrame) ?? workspace.tree);

      commitWorkspace({ ...workspace, tree, lastFocusedMember: windowId });
    };

    const doFloat = (windowId: WindowId): void => {
      const home = [...world.workspaces.values()].find((ws) =>
        tiledMembers(ws.tree).includes(windowId),
      );
      if (home === undefined) return;
      const updated = removeFromMembership(windowId, home);
      commitWorkspace({ ...updated, floating: new Set(updated.floating).add(windowId) });
    };

    const doTile = (windowId: WindowId): void => {
      const home = [...world.workspaces.values()].find((ws) => ws.floating.has(windowId));
      if (home === undefined) return;
      const updated = removeFromMembership(windowId, home);
      commitWorkspace(updated);
      insertTiledInto(home.name, windowId);
    };

    const doRemove = (windowId: WindowId): void => {
      const home = workspaceContaining(windowId);
      if (home === undefined) return;
      const wasFloating = home.floating.has(windowId);
      const updated = removeFromMembership(windowId, home);
      commitWorkspace(updated);
      tombstones.set(windowId, {
        workspace: home.name,
        floating: wasFloating,
        anchor: firstLeaf(updated.tree),
        at: clock.now(),
      });
      for (const [id, tombstone] of tombstones) {
        if (clock.now() - tombstone.at > TOMBSTONE_TTL_MS) tombstones.delete(id);
      }
    };

    // ------------------------------------------------------------------
    // Geometry application
    // ------------------------------------------------------------------

    const stepFailure = (error: GeometryFailure): StepFailure => ({
      code: error.code === "stale" ? "inventory_stale" : "geometry_rejected",
      message: error.detail ?? "geometry operation failed",
      diagnostic: JSON.stringify({ outcome: error.outcome, observed: error.observed ?? null }),
    });

    const geometryContextFor = (observation: WindowObservation) => {
      const key = profileKeyOfObs(observation);
      return {
        constraints: constraintsFor(observation),
        initialFrame: firstSeen.get(observation.id) ?? observation.frame,
        workArea: workAreaFor(observation),
        correctiveAttemptCount:
          key === null
            ? undefined
            : (world.profiles.get(profileKeyString(key))?.correctiveAttemptCount as
                | number
                | undefined),
      };
    };

    const writeFrame = (windowId: WindowId, frame: Frame, tolerance?: number) =>
      Effect.gen(function* () {
        const observation = world.windows.get(windowId);
        if (observation === undefined) {
          return yield* Effect.fail<StepFailure>({
            code: "window_not_found",
            message: `unknown window ${windowId}`,
          });
        }
        const request: GeometryRequest = {
          windowId,
          frame,
          ...(tolerance !== undefined ? { tolerance } : {}),
        };
        const result = yield* Effect.either(
          applyGeometryRequest({ adapter, clock }, request, geometryContextFor(observation)),
        );
        if (result._tag === "Left") {
          // Resistant behavior marks cooperation (profile-informed skip ahead).
          const key = profileKeyOfObs(observation);
          if (key !== null) {
            learning = markCooperation(learning, key, true);
            syncProfiles();
          }
          return yield* Effect.fail(stepFailure(result.left));
        }
        learnFrom(observation, frame, result.right.outcome, result.right.frame);
        if (result.right.outcome === "progressing") {
          bus.publish("diagnostic", {
            code: "geometry_progressing",
            detail: `window ${windowId} still animating toward target`,
          });
        }
        return result.right;
      });

    const chooseCorner = (
      display: DisplayObservation,
      size: { width: number; height: number },
    ): { corner: (typeof CORNER_PRIORITY)[number]; visibility: { horizontal: number; vertical: number } } => {
      for (const corner of CORNER_PRIORITY) {
        const fact = findParkingFact(world.parkingFacts, display, corner);
        const visibility = fact?.visibility ?? defaultParkingVisibility();
        const target = cornerTarget(display, corner, size, visibility);
        if (cornerFeasible(target, display.id, world.topology.displays)) {
          return { corner, visibility };
        }
      }
      return { corner: CORNER_PRIORITY[0]!, visibility: defaultParkingVisibility() };
    };

    const factFingerprint = (display: DisplayObservation): string =>
      `${display.id}|${display.scale}|${JSON.stringify(display.frame)}|${JSON.stringify(display.workArea)}`;

    const parkMembersOf = (
      workspaceName: string,
    ): Effect.Effect<void, StepFailure> =>
      Effect.gen(function* () {
        const workspace = world.workspaces.get(workspaceName);
        if (workspace === undefined) return;
        const display =
          displayOf(workspace.visibleOnDisplay) ??
          displayOf(workspace.pinnedDisplayOverride) ??
          displayOf(workspace.preferredDisplay) ??
          primaryDisplay();
        if (display === undefined) return;

        const members = [
          ...tiledMembers(workspace.tree),
          ...[...workspace.floating],
        ].filter((id) => {
          if (id === EMPTY_TREE_LEAF) return false;
          const obs = world.windows.get(id);
          return obs !== undefined && !obs.minimized && !obs.hidden && classify(obs) !== "transient";
        });

        for (const id of members) {
          const observation = world.windows.get(id);
          if (observation === undefined) continue;
          const intended = workspace.parkedFrames.get(id);
          if (intended !== undefined && withinTolerance(observation.frame, intended, PARKING_ACCEPTANCE_PT)) {
            continue; // already at durable intent
          }

          const size = { width: observation.frame.width, height: observation.frame.height };
          const chosen = chooseCorner(display, size);
          const target = cornerTarget(display, chosen.corner, size, chosen.visibility);

          const result = yield* Effect.either(writeFrame(id, target, PARKING_ACCEPTANCE_PT));
          if (result._tag === "Left") {
            return yield* Effect.fail(result.left);
          }

          const current = world.workspaces.get(workspaceName);
          if (current !== undefined) {
            commitWorkspace({
              ...current,
              parkedFrames: new Map(current.parkedFrames).set(id, result.right.frame satisfies Frame),
            });
          }
          world = {
            ...world,
            parkingFacts: withParkingFact(world.parkingFacts, {
              displayId: display.id,
              corner: chosen.corner,
              visibility: chosen.visibility,
              fingerprint:
                findParkingFact(world.parkingFacts, display, chosen.corner)?.fingerprint ??
                factFingerprint(display),
            }),
          };
        }
      });

    const retileVisible = (
      workspaceName: string,
    ): Effect.Effect<void, StepFailure> =>
      Effect.gen(function* () {
        const workspace = world.workspaces.get(workspaceName);
        if (workspace === undefined || workspace.mode !== "bsp") return;
        const display = displayOf(workspace.visibleOnDisplay);
        if (display === undefined) return;
        const settings = effectiveSettings(config, workspaceName);
        const resolver = constraintsResolver((id) => {
          const obs = world.windows.get(id);
          return obs === undefined ? {} : constraintsFor(obs);
        });
        const plan = planLayout({
          tree: workspace.tree,
          content: contentRect(display, settings.margins),
          gap: settings.gap,
          resolve: resolver,
        });
        if (!plan.feasible) return;
        for (const [id, frame] of plan.frames) {
          const obs = world.windows.get(id);
          if (obs === undefined || obs.minimized || obs.hidden) continue;
          if (withinTolerance(obs.frame, frame, 1)) continue;
          yield* writeFrame(id, frame, 1);
        }
      });

    const revealWorkspace = (
      workspaceName: string,
      displayId: DisplayId,
    ): Effect.Effect<void, StepFailure> =>
      Effect.gen(function* () {
        ensureWorkspace(workspaceName);
        // Park the destination's previous workspace atomically first.
        const displaced = [...world.workspaces.values()].find(
          (ws) => ws.visibleOnDisplay === displayId && ws.name !== workspaceName,
        );
        if (displaced !== undefined) {
          yield* parkMembersOf(displaced.name);
          const displacedCurrent = world.workspaces.get(displaced.name);
          if (displacedCurrent !== undefined) {
            commitWorkspace({ ...displacedCurrent, visibleOnDisplay: null });
          }
        }
        const moved = world.workspaces.get(workspaceName);
        if (moved !== undefined) {
          commitWorkspace({ ...moved, visibleOnDisplay: displayId });
        }
        yield* retileVisible(workspaceName);
      });

    const applyAction = (
      action: Action,
    ): Effect.Effect<unknown, StepFailure> =>
      Effect.gen(function* () {
        switch (action.kind) {
          case "setFrame":
            return yield* writeFrame(action.windowId, action.frame);
          case "setPosition": {
            const observation = world.windows.get(action.windowId);
            if (observation === undefined) {
              return yield* Effect.fail({
                code: "window_not_found",
                message: `unknown window ${action.windowId}`,
              });
            }
            return yield* writeFrame(action.windowId, {
              ...observation.frame,
              x: action.point.x,
              y: action.point.y,
            });
          }
          case "focusWindow":
            return yield* Effect.mapError(
              adapter.focusWindow(action.windowId),
              (e): StepFailure => ({
                code: "window_not_controllable",
                message: e.detail ?? "focus refused",
              }),
            );
          case "insertWindow":
            if (action.floating === true) {
              const workspace = ensureWorkspace(action.workspace);
              commitWorkspace({
                ...workspace,
                floating: new Set(workspace.floating).add(action.windowId),
              });
            } else {
              insertTiledInto(action.workspace, action.windowId, action.beside ?? null);
            }
            return;
          case "removeWindow":
            doRemove(action.windowId);
            return;
          case "floatWindow":
            doFloat(action.windowId);
            return;
          case "tileWindow":
            doTile(action.windowId);
            return;
          case "parkWorkspace":
            return yield* parkMembersOf(action.workspace);
          case "revealWorkspace":
            return yield* revealWorkspace(action.workspace, action.displayId);
          case "assignWorkspaceDisplay": {
            const workspace = ensureWorkspace(action.workspace);
            commitWorkspace({
              ...(world.workspaces.get(workspace.name) ?? workspace),
              pinnedDisplayOverride: action.displayId,
            });
            return yield* revealWorkspace(action.workspace, action.displayId);
          }
          case "learnConstraints": {
            const observation = world.windows.get(action.windowId);
            if (observation !== undefined) {
              learnFrom(
                observation,
                observation.frame,
                "stableClamp",
                {
                  ...observation.frame,
                  ...(action.minWidth !== undefined ? { width: action.minWidth } : {}),
                  ...(action.minHeight !== undefined ? { height: action.minHeight } : {}),
                },
              );
            }
            return;
          }
          case "emitDiagnostic":
            bus.publish("diagnostic", { code: action.code, detail: action.detail ?? "" });
            return;
        }
      });

    // ------------------------------------------------------------------
    // Rule pass → plan → transaction execution
    // ------------------------------------------------------------------

    const runRules = (): Action[] => {
      const ctx = makeCtx();
      const actions: Action[] = [];
      for (const rule of RULES) {
        try {
          if (!rule.applies(world, ctx)) continue;
          actions.push(...rule.run(world, ctx));
        } catch (error) {
          bus.publish("diagnostic", {
            code: "rule_error",
            detail: `${rule.name}: ${String(error)}`,
          });
        }
      }
      return dedupeActions(
        actions.filter((a) => !(world.paused && isSuppressedWhenPaused(a))),
      );
    };

    const executePlan = (actions: readonly Action[]): Effect.Effect<number> =>
      Effect.gen(function* () {
        if (actions.length === 0) return 0;

        const steps = actions.map((action) => {
          const windowId: WindowId | null =
            "windowId" in action ? action.windowId : null;
          const compensatable =
            windowId !== null && (action.kind === "setFrame" || action.kind === "setPosition");
          let previousFrame: Frame | null = null;

          return {
            name: `${action.kind}:${windowId ?? ""}`,
            run: () =>
              Effect.gen(function* () {
                if (windowId !== null) {
                  previousFrame = world.windows.get(windowId)?.frame ?? null;
                }
                return yield* applyAction(action);
              }),
            compensate:
              compensatable && windowId !== null
                ? () =>
                    previousFrame !== null
                      ? Effect.asVoid(
                          Effect.ignore(
                            adapter.setWindowPosition(windowId, {
                              x: previousFrame.x,
                              y: previousFrame.y,
                            }),
                          ),
                        )
                      : Effect.void
                : undefined,
          };
        });

        const unit: WorkUnit = {
          id: `plan:e${world.epoch}:${Math.floor(clock.now())}`,
          steps,
        };
        const submitted = yield* Effect.either(queue.submit(unit));
        if (submitted._tag === "Left") {
          bus.publish("diagnostic", {
            code: submitted.left.code,
            detail: "plan submission rejected",
          });
          return 0;
        }
        const receipt = submitted.right;
        if (receipt.status === "failed" && receipt.error !== undefined) {
          bus.publish("diagnostic", {
            code: receipt.error.code,
            detail: `plan ${receipt.id}: ${receipt.error.message}`,
          });
        }
        return receipt.appliedSteps.length;
      });

    const runReconcile = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (queue.isRecovering()) return;

        const topology = yield* Effect.either(validatedTopology());
        if (topology._tag === "Left") {
          setHealth("degraded");
          bus.publish("topology", { status: "invalid" });
          return;
        }
        const windowsResult = yield* Effect.either(validatedWindows());
        if (windowsResult._tag === "Left") {
          setHealth("degraded", "inventory_stale");
          bus.publish("diagnostic", {
            code: "inventory_invalid",
            detail: windowsResult.left,
          });
          return;
        }

        const windowsMap = new Map<WindowId, WindowObservation>();
        for (const observation of windowsResult.right) {
          windowsMap.set(observation.id, observation);
          if (!firstSeen.has(observation.id)) firstSeen.set(observation.id, observation.frame);
        }
        for (const id of [...firstSeen.keys()]) {
          if (!windowsMap.has(id)) firstSeen.delete(id);
        }

        world = { ...world, topology: topology.right, windows: windowsMap };

        const actions = runRules();
        const appliedCount = yield* executePlan(actions);

        if (actions.length > 0 || appliedCount > 0) {
          world = { ...world, epoch: world.epoch + 1 };
          bus.publish("reconciliation", {
            epoch: world.epoch,
            plannedActions: actions.length,
            appliedSteps: appliedCount,
          });
        }
        if (health.state === "degraded") setHealth("healthy");
      });

    let reconciling = false;
    let reconcileAgain = false;
    const gatedReconcile = (): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (reconciling) {
          reconcileAgain = true;
          return;
        }
        reconciling = true;
        try {
          yield* runReconcile();
        } finally {
          reconciling = false;
        }
        if (reconcileAgain) {
          reconcileAgain = false;
          yield* gatedReconcile();
        }
      });

    // ------------------------------------------------------------------
    // Command layer wiring
    // ------------------------------------------------------------------

    const reloadConfigNow = (mode: "delta" | "full"): Effect.Effect<CommandResult, CommandError> =>
      Effect.gen(function* () {
        const raw = yield* configSource.load();
        const parsed = parseConfigSafe(raw);
        if (!parsed.ok) {
          setHealth("degraded", "config_invalid");
          bus.publish("config", { status: "invalid", issues: parsed.error.issues.slice(0, 4) });
          return {
            type: "configChecked",
            valid: false,
            issues: [...parsed.error.issues],
          };
        }
        config = mode === "delta" ? applyConfigDelta(config, raw) : applyConfigFull(config, raw);
        setHealth("healthy");
        bus.publish("config", { status: "applied", mode });
        yield* gatedReconcile();
        return { type: "configChecked", valid: true, issues: [] };
      });

    const applyMutation = (
      command: Command,
    ): Effect.Effect<CommandResult, CommandError> =>
      Effect.gen(function* () {
        switch (command.type) {
          case "pause":
            world = { ...world, paused: true };
            bus.publish("pause", { paused: true });
            break;
          case "resume":
            world = { ...world, paused: false };
            bus.publish("pause", { paused: false });
            yield* gatedReconcile();
            break;
          case "manageWindow":
            overrides.managed.add(command.windowId);
            overrides.unmanaged.delete(command.windowId);
            yield* gatedReconcile();
            break;
          case "unmanageWindow": {
            overrides.unmanaged.add(command.windowId);
            overrides.managed.delete(command.windowId);
            doRemove(command.windowId);
            yield* gatedReconcile();
            break;
          }
          case "floatWindow":
            doFloat(command.windowId);
            yield* gatedReconcile();
            break;
          case "tileWindow":
            doTile(command.windowId);
            yield* gatedReconcile();
            break;
          case "moveWindowToWorkspace": {
            const source = workspaceContaining(command.windowId);
            const wasFloating = source?.floating.has(command.windowId) ?? false;
            if (source !== undefined) {
              commitWorkspace(removeFromMembership(command.windowId, source));
            }
            const target = ensureWorkspace(command.workspace);
            if (wasFloating) {
              const current = world.workspaces.get(target.name)!;
              commitWorkspace({
                ...current,
                floating: new Set(current.floating).add(command.windowId),
              });
            } else {
              insertTiledInto(target.name, command.windowId);
            }
            yield* gatedReconcile();
            break;
          }
          case "focusWorkspace": {
            ensureWorkspace(command.name);
            world = { ...world, focusedWorkspace: command.name };
            bus.publish("focus", { workspace: command.name });
            yield* gatedReconcile();
            break;
          }
          case "moveWorkspaceToDisplay": {
            ensureWorkspace(command.workspace);
            const ws = world.workspaces.get(command.workspace)!;
            commitWorkspace({ ...ws, pinnedDisplayOverride: command.displayId });
            const revealed = yield* Effect.either(
              revealWorkspace(command.workspace, command.displayId),
            );
            if (revealed._tag === "Left") {
              return yield* Effect.fail(
                new CommandError({ code: "topology_unstable", message: revealed.left.message }),
              );
            }
            yield* gatedReconcile();
            break;
          }
          case "setWorkspaceMode": {
            const ws = world.workspaces.get(command.workspace);
            if (ws !== undefined) commitWorkspace({ ...ws, mode: command.mode });
            yield* gatedReconcile();
            break;
          }
          case "retile":
          case "reconcile":
            yield* gatedReconcile();
            break;
          case "focusWindow":
            yield* applyAction({ kind: "focusWindow", windowId: command.windowId }).pipe(
              Effect.orElseSucceed(() => null),
            );
            break;
          case "setWindowFrame":
          case "moveWindow":
          case "resizeWindow": {
            const observation = world.windows.get(command.windowId);
            if (observation === undefined) {
              return yield* Effect.fail(
                new CommandError({
                  code: "window_not_found",
                  message: `unknown window ${command.windowId}`,
                }),
              );
            }
            const target =
              command.type === "setWindowFrame"
                ? command.frame
                : command.type === "moveWindow"
                  ? { ...observation.frame, x: command.point.x, y: command.point.y }
                  : {
                      ...observation.frame,
                      width: command.size.width,
                      height: command.size.height,
                    };
            const outcome = yield* Effect.either(writeFrame(command.windowId, target));
            if (outcome._tag === "Left") {
              return yield* Effect.fail(
                new CommandError({
                  code: outcome.left.code === "inventory_stale" ? "inventory_stale" : "geometry_rejected",
                  message: outcome.left.message,
                }),
              );
            }
            yield* gatedReconcile();
            break;
          }
          default:
            break;
        }
        return { type: "ok", detail: command.type };
      });

    const pendingMeta = (): PendingTransactionSnapshot[] =>
      queue.pending().map((p) => ({
        id: p.id,
        coalesceKey: p.coalesceKey,
        submittedAt: p.submittedAt,
      }));

    const commandBus: CommandBus = createCommandBus({
      clock,
      queue,
      getWorld: () => world,
      health: () => health.state,
      applyMutation,
      validateConfigCandidate: () =>
        Effect.succeed({ type: "configChecked", valid: true, issues: [] }),
      reloadConfig: reloadConfigNow,
      subscriptionTopics: () => [
        "health",
        "config",
        "topology",
        "workspace",
        "window",
        "focus",
        "transaction",
        "reconciliation",
        "repair",
        "pause",
        "diagnostic",
      ],
      latestEventSeq: () => bus.latestSeq(),
    });

    // ------------------------------------------------------------------
    // Lifecycle
    // ------------------------------------------------------------------

    return {
      start: () =>
        Effect.gen(function* () {
          const loaded = yield* Effect.either(configSource.load());
          if (loaded._tag === "Right") {
            const parsed = parseConfigSafe(loaded.right);
            if (parsed.ok) config = parsed.config;
            else setHealth("degraded", "config_invalid");
          } else {
            setHealth("degraded", "config_unavailable");
          }

          // Hotload: delta-reload each change; invalid candidate keeps prior.
          fibers.push(
            yield* Stream.runForEach(configSource.changes(), () =>
              Effect.gen(function* () {
                const candidate = yield* Effect.either(configSource.load());
                if (candidate._tag === "Left") return;
                const parsed = parseConfigSafe(candidate.right);
                if (!parsed.ok) {
                  setHealth("degraded", "config_invalid");
                  bus.publish("config", {
                    status: "invalid",
                    issues: parsed.error.issues.slice(0, 4),
                  });
                  return;
                }
                config = applyConfigDelta(config, candidate.right);
                setHealth("healthy");
                bus.publish("config", { status: "hotloaded" });
                yield* gatedReconcile();
              }),
            ).pipe(Effect.forkDaemon),
          );

          // Initial reconcile + rule pass.
          yield* runReconcile();

          // Event-driven reconcile: adapter events are hints → re-query snapshots.
          fibers.push(
            yield* Stream.runForEach(adapter.events, () => gatedReconcile()).pipe(
              Effect.forkDaemon,
            ),
          );

          bus.publish("health", { state: health.state, issues: [...health.issues] });
        }),
      stop: () =>
        Effect.gen(function* () {
          for (const fiber of fibers) {
            yield* Effect.ignore(Fiber.interrupt(fiber));
          }
          fibers.length = 0;
          bus.publish("diagnostic", { code: "engine_stopped", detail: "" });
        }),
      execute: (command: Command) =>
        Effect.flatMap(
          Effect.try({
            try: () => decodeCommandSync(command),
            catch: () => new CommandError({ code: "invalid_request", message: "malformed command" }),
          }),
          (validated) => commandBus.execute(validated),
        ),
      state: () => Effect.succeed(projectSnapshot(world, health.state, pendingMeta())),
      events: () => bus.events(),
      reconcile: () => gatedReconcile(),
    };
  });

function emptyWorkspace(name: string): WorkspaceState {
  return {
    name,
    mode: "bsp",
    tree: { kind: "leaf", windowId: EMPTY_TREE_LEAF },
    floating: new Set(),
    visibleOnDisplay: null,
    preferredDisplay: null,
    pinnedDisplayOverride: null,
    parkedFrames: new Map(),
    lastFocusedMember: null,
  };
}
