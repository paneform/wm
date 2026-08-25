import { Effect, Fiber, Schema, Stream } from "effect";
import type { ConfigSource, PlatformAdapter, Clock } from "./platform.ts";
import { TopologyObservation, WindowObservation } from "./schema.ts";
import type {
  Constraints,
  DisplayId,
  DisplayObservation,
  ExpectedWindowIdentity,
  Frame,
  GeometryRequest,
  WindowId,
  WorkspaceName,
} from "./schema.ts";
import type { DomainTopic } from "./events.ts";
import {
  classify,
  type BspNode,
  type ProfileKey,
  type World,
  type WorkspaceState,
} from "./world.ts";
import { DEFAULT_TOLERANCE, EMPTY_TREE_LEAF, PARKING_ACCEPTANCE_PT } from "./constants.ts";
import { center, withinTolerance } from "./geometry.ts";
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
  boundsFromConstraints,
  contentRect,
  constraintsResolver,
  firstLeaf,
  insertLeaf,
  isEmptyTree,
  planLayout,
  removeLeaf,
  swapLeaves,
  tiledMembers,
} from "./layout/bsp.ts";
import { directionalNeighbor, type DirectionalCandidate } from "./direction.ts";
import type { Action } from "./actions.ts";
import { dedupeActions } from "./actions.ts";
import {
  createCommandBus,
  decodeCommandSync,
  projectSnapshot,
  type Command,
  type CommandBus,
  type CommandErrorCode,
  type CommandResult,
  type HealthState,
  type PendingTransactionSnapshot,
  type StateSnapshot,
} from "./commands.ts";
import { CommandError, mapStepCode } from "./commands.ts";
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
  type EffectiveWorkspaceSettings,
} from "./config.ts";

// Engine pipeline — docs/rewrite/engine-guide.md §Pipeline.
// Platform events are HINTS that trigger re-querying snapshots; rules produce
// an Action plan; the transaction executor applies actions via adapter
// primitives with verification; commits bump the World epoch and emit events.

export interface EngineOptions {
  adapter: PlatformAdapter;
  configSource: ConfigSource;
  clock: Clock;
  /** Start observation/config/event processing while suppressing mutations. */
  initiallyPaused?: boolean;
}

export interface Engine {
  start(): Effect.Effect<void>;
  stop(): Effect.Effect<void>;
  execute(command: Command): Effect.Effect<CommandResult, CommandError>;
  state(): Effect.Effect<StateSnapshot>;
  events(): Stream.Stream<DomainEvent>;
  reconcile(): Effect.Effect<void>;
  /** Test/ops hook: toggles the transaction queue's recovery mode. */
  setRecovery(active: boolean): void;
  /** Deterministic gate introspection for tests (review round 4, issue 1). */
  gateState(): { busy: boolean; rerunQueued: boolean };
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
      paused: options.initiallyPaused ?? false,
      epoch: 0,
      focusIntent: null,
    };
    let config: Config = {};
    let learning: LearningStore = emptyLearningStore();
    const tombstones = new Map<WindowId, TombstoneRecord>();
    const overrides = { managed: new Set<WindowId>(), unmanaged: new Set<WindowId>() };
    const firstSeen = new Map<WindowId, Frame>();
    const health: HealthRef = { state: "healthy", issues: [] };
    const fibers: Array<Fiber.RuntimeFiber<unknown, unknown>> = [];
    /**
     * Focus tracking (review round 2, issue 6): the authoritative engine
     * intent lives in `world.focusIntent` (atomic with every swap). This
     * shadow records the focus reported by the LAST observation pass so a
     * PLATFORM-SIDE CHANGE can be detected: a changed report is newer
     * information than any earlier engine decision and supersedes the
     * intent; an unchanged report (stale/delayed snapshots, unrelated
     * reconciles) never disturbs it.
     */
    let lastObservedFocusId: WindowId | null | undefined = undefined;
    let focusGeneration = 0;
    /**
     * Focus signals consumed from ordered PlatformEvent.focus_changed
     * occurrences (review round 3, issue 5). An event is authoritative newer
     * information: it supersedes the intent even when its id equals the last
     * STALE snapshot report (change-detection alone cannot express that).
     * Signals arriving while a compound transaction holds the gate are
     * applied right after commit, before the rerun reconcile.
     */
    let pendingFocusSignal: WindowId | null | undefined = undefined;

    const applyFocusSignal = (id: WindowId | null): void => {
      // Deliberately does NOT touch lastObservedFocusId: the event is AHEAD
      // of observation snapshots; polluting snapshot-side state would make
      // the very next refresh look like a competing "change".
      focusGeneration += 1;
      world = {
        ...world,
        focusIntent: id === null ? null : { id, generation: focusGeneration },
      };
    };

    const consumeFocusSignal = (id: WindowId | null): void => {
      if (reconciling) {
        // Coalesced: newest signal wins; applied pre-idle at release.
        pendingFocusSignal = id;
      } else applyFocusSignal(id);
    };

    const bus: EventBus = createEventBus();
    const queue: TransactionQueue = createTransactionQueue({
      clock,
      onDiagnostic: () => {},
    });
    /** Exclusive command/reconcile mutex (review round 3, issue 6). */
    const reconcileGate = yield* Effect.makeSemaphore(1);

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

    /** Command-visible reconcile failure (review issue 1: propagate, never swallow). */
    interface ReconcileFailure {
      readonly code: CommandErrorCode;
      readonly message: string;
    }

    interface PlanOutcome {
      readonly applied: number;
      readonly failure: ReconcileFailure | null;
    }

    const executePlan = (actions: readonly Action[]): Effect.Effect<PlanOutcome> =>
      Effect.gen(function* () {
        if (actions.length === 0) return { applied: 0, failure: null };

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
          return {
            applied: 0,
            failure: {
              code: submitted.left.code === "queue_full" ? "queue_full" : mapStepCode(submitted.left.code),
              message: "plan submission rejected",
            },
          };
        }
        const receipt = submitted.right;
        if (receipt.status === "failed" && receipt.error !== undefined) {
          bus.publish("diagnostic", {
            code: receipt.error.code,
            detail: `plan ${receipt.id}: ${receipt.error.message}`,
          });
        }
        const failure: ReconcileFailure | null =
          receipt.status === "failed"
            ? {
                code: mapStepCode(receipt.error?.code),
                message: receipt.error?.message ?? "operation failed",
              }
            : receipt.status === "timeout"
              ? { code: "timeout", message: "operation timed out" }
              : null;
        return { applied: receipt.appliedSteps.length, failure };
      });

    const runReconcile = (): Effect.Effect<void, ReconcileFailure> =>
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

        // Focus sync by CHANGE-DETECTION (issue 6): only a platform report
        // that DIFFERS from the previous pass supersedes the engine intent —
        // stale/delayed snapshots repeat the old answer and are ignored.
        const platformFocused = [...windowsMap.values()].find((o) => o.focused) ?? null;
        const reportedId = platformFocused?.id ?? null;
        if (reportedId !== lastObservedFocusId) {
          lastObservedFocusId = reportedId;
          if (reportedId !== null) {
            focusGeneration += 1;
            world = {
              ...world,
              focusIntent: { id: reportedId, generation: focusGeneration },
            };
          } else {
            // An observed transition TO no-focus is authoritative new
            // information (user clicked the desktop) — it supersedes.
            world = { ...world, focusIntent: null };
          }
        } else if (world.focusIntent !== null && !windowsMap.has(world.focusIntent.id)) {
          world = { ...world, focusIntent: null }; // intent window died
        }

        world = { ...world, topology: topology.right, windows: windowsMap };

        const actions = runRules();
        const outcome = yield* executePlan(actions);

        if (actions.length > 0 || outcome.applied > 0) {
          world = { ...world, epoch: world.epoch + 1 };
          bus.publish("reconciliation", {
            epoch: world.epoch,
            plannedActions: actions.length,
            appliedSteps: outcome.applied,
          });
        }
        if (health.state === "degraded") setHealth("healthy");
        if (outcome.failure !== null) return yield* Effect.fail(outcome.failure);
      });

    /**
     * Exclusive command/reconcile section (review round 3, issue 6): proper
     * semaphore suspension — commands wait behind legitimately slow
     * reconciliation instead of bounded spinning. `reconciling` mirrors busy
     * state so background passes can defer-and-rerun instead of queuing.
     */
    const runExclusive = <A, E>(inner: Effect.Effect<A, E>): Effect.Effect<A, E> =>
      Effect.acquireUseRelease(
        Effect.gen(function* () {
          yield* reconcileGate.take(1);
          reconciling = true;
        }),
        () => inner,
        () =>
          Effect.gen(function* () {
            // A focus signal that arrived while the gate was held applies
            // BEFORE idle/release so a waiting command observes the
            // authoritative intent (review round 3 final, issue 4).
            if (pendingFocusSignal !== undefined) {
              const signal = pendingFocusSignal;
              pendingFocusSignal = undefined;
              applyFocusSignal(signal);
            }
            reconciling = false;
            yield* reconcileGate.release(1);
            if (reconcileAgain) {
              reconcileAgain = false;
              void Effect.runPromise(gatedReconcile()).catch(() => {});
            }
          }),
      );

    let reconciling = false;
    let reconcileAgain = false;

    const gatedReconcile = (): Effect.Effect<void> =>
      Effect.flatMap(Effect.sync(() => !reconciling), (canRun) => {
        if (!canRun) {
          // Busy: coalesce this request — the exclusive-section release
          // applies pending focus signals, clears the flag, and KICKS the
          // deferred rerun (post-release convergence guarantee).
          reconcileAgain = true;
          return Effect.void;
        }
        return runExclusive(Effect.ignore(runReconcile()));
      });

    // ------------------------------------------------------------------
    // Compound command transaction core — pure reducer → scoped plan →
    // verified executor → atomic commit with buffered events.
    //
    //   runExclusive (semaphore) — whole operation holds the reconcile mutex.
    //   CAPTURE  (interruptible) — identity+frame from the ADAPTER; missing
    //                              required window ⇒ inventory_stale, zero
    //                              mutations.
    //   TENTATIVE (interruptible) — strict validations, PURE reducer over an
    //                              isolated draft, scoped plan build, paused
    //                              check, sequential verified writes.
    //   FINALIZE (uninterruptible, onExit) — success: atomic committed swap +
    //                              buffered event flush; failure OR
    //                              interruption: draft discarded and
    //                              identity-checked frame compensation with
    //                              readback verification; impossibility ⇒
    //                              degraded health (never unguarded retries).
    // ------------------------------------------------------------------

    type BufferedEvent = { topic: DomainTopic; payload: Record<string, unknown> };

    type CompoundIntent =
      | { kind: "retile"; workspace: WorkspaceName }
      | { kind: "park"; workspace: WorkspaceName; displayId: DisplayId | null };

    /** Physical frame capture WITH identity for safe compensation. */
    interface CapturedFrame {
      readonly id: WindowId;
      readonly identity: string;
      readonly frame: Frame;
      /** Precondition handed to the adapter's ATOMIC identity-guarded write. */
      readonly expected: ExpectedWindowIdentity;
    }

    /**
     * Canonical identity fingerprint (contract §4):
     * `JSON.stringify([pid, role ?? null, subrole ?? null])` — shared
     * verbatim by adapters so same-pid/role replacements differing in
     * subrole (null vs non-null) still mismatch.
     */
    const windowIdentityOf = (obs: WindowObservation): string =>
      JSON.stringify([obs.pid, obs.role ?? null, obs.subrole ?? null]);

    interface PlannedWrite {
      readonly windowId: WindowId;
      readonly frame: Frame;
      readonly tolerance?: number | undefined;
    }

    // --- pure state operations over an explicit World parameter ---

    const primaryDisplayIn = (w: World): DisplayObservation | undefined =>
      w.topology.displays.find((d) => d.primary) ?? w.topology.displays[0];

    const displayOfIn = (w: World, id: DisplayId | null): DisplayObservation | undefined =>
      id === null ? undefined : w.topology.displays.find((d) => d.id === id);

    const ensureWorkspaceIn = (w: World, name: string): World => {
      if (w.workspaces.has(name)) return w;
      const focusedVisible =
        w.focusedWorkspace !== null
          ? w.workspaces.get(w.focusedWorkspace)?.visibleOnDisplay
          : undefined;
      const created: WorkspaceState = {
        name,
        mode: "bsp",
        tree: { kind: "leaf", windowId: EMPTY_TREE_LEAF },
        floating: new Set(),
        visibleOnDisplay: focusedVisible ?? primaryDisplayIn(w)?.id ?? null,
        preferredDisplay: null,
        pinnedDisplayOverride: null,
        parkedFrames: new Map(),
        lastFocusedMember: null,
      };
      return { ...w, workspaces: new Map(w.workspaces).set(name, created) };
    };

    const workspaceContainingIn = (w: World, windowId: WindowId): WorkspaceState | undefined =>
      [...w.workspaces.values()].find(
        (ws) => tiledMembers(ws.tree).includes(windowId) || ws.floating.has(windowId),
      );

    /**
     * Split-axis choice reads the COMMITTED generation's frames
     * (`framesWorld`) — topology policy deliberately ignores same-pass
     * geometry writes; plan deltas use fresh observations.
     */
    const insertTiledIntoIn = (
      w: World,
      wsName: string,
      windowId: WindowId,
      framesWorld: World,
      besideHint?: WindowId | null,
    ): World => {
      const withWs = ensureWorkspaceIn(w, wsName);
      const ws = withWs.workspaces.get(wsName)!;
      const members = tiledMembers(ws.tree);
      const beside =
        besideHint !== undefined && besideHint !== null && members.includes(besideHint)
          ? besideHint
          : ws.lastFocusedMember !== null && members.includes(ws.lastFocusedMember)
            ? ws.lastFocusedMember
            : members[0];
      const besideFrame = beside === undefined ? undefined : framesWorld.windows.get(beside)?.frame;
      const tree =
        beside === undefined || besideFrame === undefined || isEmptyTree(ws.tree)
          ? ({ kind: "leaf", windowId } as BspNode)
          : (insertLeaf(ws.tree, beside, windowId, besideFrame) ?? ws.tree);
      return {
        ...withWs,
        workspaces: new Map(withWs.workspaces).set(wsName, {
          ...ws,
          tree,
          lastFocusedMember: windowId,
        }),
      };
    };

    const moveWindowBetweenWorkspacesIn = (
      w: World,
      windowId: WindowId,
      workspaceName: string,
      framesWorld: World,
    ): World => {
      const source = workspaceContainingIn(w, windowId);
      if (source?.name === workspaceName) return w;
      const wasFloating = source?.floating.has(windowId) ?? false;
      let next = w;
      if (source !== undefined) {
        next = {
          ...next,
          workspaces: new Map(next.workspaces).set(
            source.name,
            removeFromMembership(windowId, source),
          ),
        };
      }
      next = ensureWorkspaceIn(next, workspaceName);
      const target = next.workspaces.get(workspaceName)!;
      if (wasFloating) {
        return {
          ...next,
          workspaces: new Map(next.workspaces).set(workspaceName, {
            ...target,
            floating: new Set(target.floating).add(windowId),
          }),
        };
      }
      return insertTiledIntoIn(next, workspaceName, windowId, framesWorld);
    };

    /** Reveal a workspace on a display inside the DRAFT: parks the displaced
     * workspace's intent (carrying its ORIGINAL display) and queues retiles. */
    const revealIn = (
      draft0: World,
      intents: CompoundIntent[],
      wsName: string,
      displayId: DisplayId,
    ): World => {
      let draft = ensureWorkspaceIn(draft0, wsName);
      const displaced = [...draft.workspaces.values()].find(
        (w) => w.visibleOnDisplay === displayId && w.name !== wsName,
      );
      if (displaced !== undefined) {
        intents.push({
          kind: "park",
          workspace: displaced.name,
          displayId: displaced.visibleOnDisplay,
        });
        draft = {
          ...draft,
          workspaces: new Map(draft.workspaces).set(displaced.name, {
            ...displaced,
            visibleOnDisplay: null,
          }),
        };
      }
      const ws = draft.workspaces.get(wsName)!;
      draft = {
        ...draft,
        workspaces: new Map(draft.workspaces).set(wsName, { ...ws, visibleOnDisplay: displayId }),
      };
      intents.push({ kind: "retile", workspace: wsName });
      return draft;
    };

    // --- scoped plan builder (pure) ---

    interface PlanAccessors {
      observationOf(id: WindowId): WindowObservation | undefined;
      constraintsFor(obs: WindowObservation): Constraints;
      settingsFor(name: string): EffectiveWorkspaceSettings;
      ignoredSurface(obs: WindowObservation): boolean;
    }

    type BuiltPlan =
      | { ok: true; writes: PlannedWrite[]; draft: World }
      | { ok: false; error: CommandError };

    const buildCompoundPlan = (
      start: World,
      intents: readonly CompoundIntent[],
      acc: PlanAccessors,
    ): BuiltPlan => {
      const writes: PlannedWrite[] = [];
      let draft = start;

      const planRetile = (wsName: WorkspaceName): CommandError | null => {
        const ws = draft.workspaces.get(wsName);
        if (ws === undefined || ws.mode !== "bsp") return null;
        const display = displayOfIn(draft, ws.visibleOnDisplay);
        if (display === undefined) {
          if (ws.visibleOnDisplay !== null) {
            return new CommandError({
              code: "topology_unstable",
              message: `display ${ws.visibleOnDisplay} hosting workspace ${wsName} is gone`,
            });
          }
          return null; // not visible anywhere — nothing to tile
        }
        const settings = acc.settingsFor(wsName);
        const resolver = constraintsResolver((id) => {
          const obs = acc.observationOf(id);
          return obs === undefined ? undefined : acc.constraintsFor(obs);
        });
        const plan = planLayout({
          tree: ws.tree,
          content: contentRect(display, settings.margins),
          gap: settings.gap,
          resolve: resolver,
        });
        if (!plan.feasible) {
          return new CommandError({
            code: "geometry_rejected",
            message: `layout infeasible for workspace ${wsName}`,
          });
        }
        for (const [id, frame] of plan.frames) {
          const obs = acc.observationOf(id);
          if (obs === undefined || obs.minimized || obs.hidden) continue;
          if (!withinTolerance(obs.frame, frame as Frame, DEFAULT_TOLERANCE)) {
            writes.push({ windowId: id, frame: frame as Frame });
          }
        }
        return null;
      };

      const planPark = (
        wsName: WorkspaceName,
        originalDisplayId: DisplayId | null,
      ): CommandError | null => {
        const ws = draft.workspaces.get(wsName);
        if (ws === undefined) return null;
        // Park on the display the workspace ORIGINALLY occupied — visibility
        // was already cleared in the draft, so the intent carries it.
        const display = originalDisplayId
          ? displayOfIn(draft, originalDisplayId)
          : (displayOfIn(draft, ws.visibleOnDisplay ?? ws.pinnedDisplayOverride ?? ws.preferredDisplay) ??
            primaryDisplayIn(draft));
        if (display === undefined) {
          if (originalDisplayId !== null) {
            return new CommandError({
              code: "topology_unstable",
              message: `display ${originalDisplayId} hosting displaced workspace ${wsName} is gone`,
            });
          }
          return null;
        }
        const memberIds = [...tiledMembers(ws.tree), ...[...ws.floating]].filter(
          (id) => id !== EMPTY_TREE_LEAF && draft.windows.has(id),
        );
        for (const id of memberIds) {
          const observation = draft.windows.get(id)!;
          if (
            observation.minimized ||
            observation.hidden ||
            classify(observation) === "transient" ||
            acc.ignoredSurface(observation)
          ) {
            continue;
          }
          const intended = ws.parkedFrames.get(id);
          if (
            intended !== undefined &&
            withinTolerance(observation.frame, intended, PARKING_ACCEPTANCE_PT)
          ) {
            continue; // already at durable intent
          }
          const size = { width: observation.frame.width, height: observation.frame.height };
          let chosen: (typeof CORNER_PRIORITY)[number] | null = null;
          let visibility = defaultParkingVisibility();
          for (const corner of CORNER_PRIORITY) {
            const fact = findParkingFact(draft.parkingFacts, display, corner);
            visibility = fact?.visibility ?? defaultParkingVisibility();
            const target = cornerTarget(display, corner, size, visibility);
            if (cornerFeasible(target, display.id, draft.topology.displays)) {
              chosen = corner;
              break;
            }
          }
          const corner = chosen ?? CORNER_PRIORITY[0]!;
          const target = cornerTarget(display, corner, size, visibility);
          writes.push({ windowId: id, frame: target, tolerance: PARKING_ACCEPTANCE_PT });
          draft = {
            ...draft,
            workspaces: new Map(draft.workspaces).set(wsName, {
              ...(draft.workspaces.get(wsName)!),
              parkedFrames: new Map(ws.parkedFrames).set(id, target),
            }),
          };
          const existingFact = findParkingFact(draft.parkingFacts, display, corner);
          draft = {
            ...draft,
            parkingFacts: withParkingFact(draft.parkingFacts, {
              displayId: display.id,
              corner,
              visibility,
              fingerprint:
                existingFact?.fingerprint ??
                `${display.id}|${display.scale}|${JSON.stringify(display.frame)}|${JSON.stringify(display.workArea)}`,
            }),
          };
        }
        return null;
      };

      for (const intent of intents) {
        const error =
          intent.kind === "retile"
            ? planRetile(intent.workspace)
            : planPark(intent.workspace, intent.displayId);
        if (error !== null) return { ok: false, error };
      }
      return { ok: true, writes, draft };
    };

    interface CompoundCtx {
      preFrames: CapturedFrame[];
      events: BufferedEvent[];
      intents: CompoundIntent[];
      draft: World;
      finalDraft: World;
      appliedActions: number;
    }

    /**
     * Execute a compound command transactionally (see block comment above).
     */
    const executeCompound = (
      trackedIds: readonly WindowId[],
      reduce: (tools: {
        intents: CompoundIntent[];
        buffer: BufferedEvent[];
        /** Committed world at entry — topology-policy frame source. */
        base: World;
      }) => (world0: World) => World,
    ): Effect.Effect<void, CommandError> =>
      runExclusive(
        Effect.gen(function* () {
          // ---- capture phase: INTERRUPTIBLE, before any mutation. A
          // required affected window that is missing/unreadable fails
          // inventory_stale with ZERO mutations performed.
          const preFrames: CapturedFrame[] = [];
          for (const id of trackedIds) {
            const current = yield* Effect.either(adapter.getWindow(id));
            if (current._tag === "Left" || current.right === null) {
              return yield* Effect.fail(
                new CommandError({
                  code: "inventory_stale",
                  message: `affected window ${id} could not be captured`,
                }),
              );
            }
            const captured = current.right;
            const identity = windowIdentityOf(captured);
            preFrames.push({
              id,
              identity,
              frame: { ...captured.frame },
              // REQUIRED-NULLABLE semantics collapse into one exact token:
              // subrole is ALWAYS present as null or the real value.
              expected: { fingerprint: identity },
            });
          }
          const ctx: CompoundCtx = {
            preFrames,
            events: [],
            intents: [],
            draft: world,
            finalDraft: world,
            appliedActions: 0,
          };

          // ---- tentative phase; finalize on ANY exit incl. interruption.
          return yield* Effect.onExit(
            Effect.gen(function* () {
              if (queue.isRecovering()) {
                return yield* Effect.fail(
                  new CommandError({
                    code: "internal_error",
                    message: "engine recovery in progress",
                  }),
                );
              }
              const windowsFresh = yield* Effect.either(validatedWindows());
              if (windowsFresh._tag === "Left") {
                return yield* Effect.fail(
                  new CommandError({ code: "inventory_stale", message: "window inventory invalid" }),
                );
              }
              const topoFresh = yield* Effect.either(validatedTopology());
              if (topoFresh._tag === "Left") {
                return yield* Effect.fail(
                  new CommandError({
                    code: "topology_unstable",
                    message: "topology observation invalid",
                  }),
                );
              }
              ctx.draft = {
                ...world,
                topology: topoFresh.right,
                windows: new Map(windowsFresh.right.map((o) => [o.id, o])),
              };
              ctx.draft = reduce({ intents: ctx.intents, buffer: ctx.events, base: world })(
                ctx.draft,
              );
              const built = buildCompoundPlan(ctx.draft, ctx.intents, {
                observationOf: (id) => ctx.draft.windows.get(id),
                constraintsFor: (obs) => constraintsFor(obs),
                settingsFor: (name) => effectiveSettings(config, name),
                ignoredSurface: (obs) =>
                  classify(obs) !== "normal" &&
                  classify(obs) !== "transient" &&
                  !overrides.managed.has(obs.id),
              });
              if (!built.ok) return yield* Effect.fail(built.error);
              if (world.paused && built.writes.length > 0) {
                return yield* Effect.fail(
                  new CommandError({
                    code: "paused",
                    message: "engine is paused; required geometry plan suppressed",
                  }),
                );
              }
              let applied = 0;
              for (const wr of built.writes) {
                const result = yield* Effect.either(writeFrame(wr.windowId, wr.frame, wr.tolerance));
                if (result._tag === "Left") {
                  return yield* Effect.fail(
                    new CommandError({
                      code: mapStepCode(result.left.code),
                      message: result.left.message,
                    }),
                  );
                }
                applied += 1;
              }
              ctx.appliedActions = applied;
              ctx.finalDraft = ctx.draft;
              return ctx.draft;
            }),
            (exit) =>
              Effect.gen(function* () {
                if (exit._tag === "Success") {
                  world = { ...ctx.finalDraft, epoch: ctx.finalDraft.epoch + 1 };
                  for (const event of ctx.events) bus.publish(event.topic, event.payload);
                  bus.publish("reconciliation", {
                    epoch: world.epoch,
                    plannedActions: ctx.appliedActions,
                    appliedSteps: ctx.appliedActions,
                  });
                  return;
                }
                let incomplete = false;
                for (const cap of [...ctx.preFrames].reverse()) {
                  const observedNow = yield* Effect.either(adapter.getWindow(cap.id));
                  if (observedNow._tag === "Left" || observedNow.right === null) {
                    incomplete = true;
                    continue;
                  }
                  if (windowIdentityOf(observedNow.right) !== cap.identity) {
                    incomplete = true;
                    bus.publish("diagnostic", {
                      code: "rollback_identity_changed",
                      detail: `window ${cap.id}: replacement detected; compensation skipped`,
                    });
                    continue;
                  }
                  if (withinTolerance(observedNow.right.frame, cap.frame, DEFAULT_TOLERANCE)) continue;
                  // ATOMIC identity-guarded restore (issue 3): the adapter
                  // re-validates `expected` immediately before mutating, so a
                  // replacement inserted between our read and this write
                  // aborts `stale` untouched. Never retried unguarded.
                  const written = yield* Effect.either(
                    adapter.setWindowFrame(cap.id, { ...cap.frame }, { ...cap.expected }),
                  );
                  if (written._tag === "Left") {
                    incomplete = true;
                    bus.publish("diagnostic", {
                      code: "rollback_write_refused",
                      detail: `window ${cap.id}: restoration refused (${written.left.code})`,
                    });
                    continue;
                  }
                  const verified = withinTolerance(written.right.observed, cap.frame, DEFAULT_TOLERANCE);
                  if (!verified) incomplete = true;
                }
                if (incomplete) setHealth("degraded", "rollback_incomplete");
              }),
          );
        }),
      );

    // ------------------------------------------------------------------
    // Focused-window / directional resolution (bean wm-pmys parity commands)
    // ------------------------------------------------------------------

    /** Raw platform truth: whatever observation currently reports focused. */
    const anyFocusedObservation = (): WindowObservation | null => {
      for (const observation of world.windows.values()) {
        if (observation.focused) return observation;
      }
      return null;
    };

    /**
     * Engine-truth focus: the live focus intent from committed world —
     * engine-issued or adopted-from-change. Survives stale snapshots until
     * an authoritative newer platform change supersedes it (issue 6).
     */
    const logicalFocusedObservation = (): WindowObservation | null => {
      const intent = world.focusIntent;
      if (intent === null) return null;
      const observation = world.windows.get(intent.id);
      return observation !== undefined && classify(observation) === "normal"
        ? observation
        : null;
    };

    const isMemberOf = (workspace: WorkspaceState, windowId: WindowId): boolean =>
      tiledMembers(workspace.tree).includes(windowId) || workspace.floating.has(windowId);

    /** Live member ids (tiled + floating) of a workspace, stable order. */
    const memberIdsOf = (wsName: WorkspaceName | null | undefined): WindowId[] => {
      const ws = wsName === null || wsName === undefined ? undefined : world.workspaces.get(wsName);
      if (ws === undefined) return [];
      return [...tiledMembers(ws.tree), ...[...ws.floating]].filter(
        (id) => id !== EMPTY_TREE_LEAF && world.windows.has(id),
      );
    };

    /** Live members of whichever workspace currently occupies a display. */
    const occupantIdsOfDisplay = (displayId: DisplayId | null): WindowId[] => {
      if (displayId === null) return [];
      const occupant = [...world.workspaces.values()].find(
        (ws) => ws.visibleOnDisplay === displayId,
      );
      return occupant === undefined ? [] : memberIdsOf(occupant.name);
    };

    // ------------------------------------------------------------------
    // (compound transaction core lives above — pure reducer/plan/executor)
    // ------------------------------------------------------------------

    /**
     * Focused target for moveFocusedWindowToWorkspace (review issue 5):
     * engine logical focus wins; otherwise an OBSERVED focused window is
     * used iff normal — if one exists but is not manageable the command
     * FAILS rather than guessing. The lastFocusedMember fallback applies
     * only when NO focused observation exists at all, and only when that
     * member is still live and still a member.
     */
    const resolveFocusedMoveTarget = (): Effect.Effect<WindowId, CommandError> =>
      Effect.gen(function* () {
        const logical = logicalFocusedObservation();
        if (logical !== null) return logical.id;
        const observed = anyFocusedObservation();
        if (observed !== null) {
          if (classify(observed) === "normal") return observed.id;
          return yield* Effect.fail(
            new CommandError({
              code: "window_not_manageable",
              message: "the focused window is not a manageable normal window",
            }),
          );
        }
        const wsName = world.focusedWorkspace;
        const ws = wsName === null ? undefined : world.workspaces.get(wsName);
        const candidate = ws?.lastFocusedMember ?? null;
        if (
          ws !== undefined &&
          candidate !== null &&
          world.windows.has(candidate) &&
          isMemberOf(ws, candidate)
        ) {
          return candidate;
        }
        return yield* Effect.fail(
          new CommandError({
            code: "window_not_found",
            message: "no focused window and no live fallback member in the focused workspace",
          }),
        );
      });

    interface DirectionContext {
      readonly workspaceName: WorkspaceName;
      readonly workspace: WorkspaceState;
      readonly originId: WindowId;
      readonly candidates: readonly DirectionalCandidate[];
    }

    /**
     * Resolve the focused workspace plus a deterministic origin for
     * directional commands (logical/observed focus → lastFocusedMember →
     * first member). Non-BSP workspaces are rejected with a structured error
     * (review issue 4). Candidates keep stable order (tiled traversal, then
     * floating).
     */
    const resolveDirectionContext = (): Effect.Effect<DirectionContext, CommandError> =>
      Effect.gen(function* () {
        const wsName = world.focusedWorkspace;
        const workspace = wsName === null ? undefined : world.workspaces.get(wsName);
        if (wsName === null || workspace === undefined) {
          return yield* Effect.fail(
            new CommandError({ code: "workspace_not_found", message: "no focused workspace" }),
          );
        }
        if (workspace.mode !== "bsp") {
          return yield* Effect.fail(
            new CommandError({
              code: "window_not_manageable",
              message: `directional commands require a bsp-mode workspace (${wsName} is ${workspace.mode})`,
            }),
          );
        }
        const logical = logicalFocusedObservation();
        const observed = anyFocusedObservation();
        const focusedNormal =
          logical ??
          (observed !== null && classify(observed) === "normal" ? observed : null);

        const fallback =
          workspace.lastFocusedMember !== null &&
          world.windows.has(workspace.lastFocusedMember) &&
          isMemberOf(workspace, workspace.lastFocusedMember)
            ? workspace.lastFocusedMember
            : null;
        const originId =
          focusedNormal !== null && isMemberOf(workspace, focusedNormal.id)
            ? focusedNormal.id
            : (fallback ?? tiledMembers(workspace.tree)[0] ?? [...workspace.floating][0]);
        if (originId === undefined || originId === EMPTY_TREE_LEAF) {
          return yield* Effect.fail(
            new CommandError({ code: "window_not_found", message: "workspace has no members" }),
          );
        }
        const candidates: DirectionalCandidate[] = [
          ...tiledMembers(workspace.tree),
          ...[...workspace.floating],
        ]
          .filter((id) => id !== originId && id !== EMPTY_TREE_LEAF && world.windows.has(id))
          .map((id) => {
            const frame = world.windows.get(id)!.frame;
            return { id, x: center(frame).x, y: center(frame).y };
          });
        return { workspaceName: wsName, workspace, originId, candidates };
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

    // ------------------------------------------------------------------
    // Reusable explicit mutations (shared by direct + focused commands)
    // ------------------------------------------------------------------

    /** Move a window into a workspace, preserving its floating mode.
     * Moving into the CURRENT workspace is a no-op: repeated hotkey presses
     * and races with auto-assignment must never churn the tree or reset
     * lastFocusedMember. */
    const moveWindowBetweenWorkspaces = (windowId: WindowId, workspaceName: string): void => {
      const source = workspaceContaining(windowId);
      if (source?.name === workspaceName) return;
      const wasFloating = source?.floating.has(windowId) ?? false;
      if (source !== undefined) {
        commitWorkspace(removeFromMembership(windowId, source));
      }
      const target = ensureWorkspace(workspaceName);
      if (wasFloating) {
        const current = world.workspaces.get(target.name)!;
        commitWorkspace({
          ...current,
          floating: new Set(current.floating).add(windowId),
        });
      } else {
        insertTiledInto(target.name, windowId);
      }
    };

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
          case "togglePause": {
            // Atomic read-modify-write on committed state inside the
            // serialized transaction step — never a CLI query + race.
            const next = !world.paused;
            world = { ...world, paused: next };
            bus.publish("pause", { paused: next });
            if (!next) yield* gatedReconcile();
            break;
          }
          case "moveFocusedWindowToWorkspace": {
            const windowId = yield* resolveFocusedMoveTarget();
            // Actual membership drives the display decision — NOT
            // world.focusedWorkspace (review issue 2).
            const sourceWs =
              workspaceContainingIn(world, windowId) ??
              (world.focusedWorkspace === null
                ? undefined
                : world.workspaces.get(world.focusedWorkspace));
            const sourceDisplay =
              sourceWs?.visibleOnDisplay ??
              sourceWs?.pinnedDisplayOverride ??
              sourceWs?.preferredDisplay ??
              primaryDisplay()?.id ??
              null;
            const destPre = world.workspaces.get(command.workspace);
            const preferredDestDisplay = destPre
              ? (destPre.visibleOnDisplay ??
                destPre.pinnedDisplayOverride ??
                destPre.preferredDisplay ??
                sourceDisplay)
              : sourceDisplay;
            // An EXISTING destination keeps its current visible display; only
            // a new/unassigned destination inherits the source's display.
            const destDisplay =
              displayOf(preferredDestDisplay) !== undefined ? preferredDestDisplay : sourceDisplay;
            const affected = Array.from(
              new Set([
                windowId,
                ...(sourceWs ? memberIdsOf(sourceWs.name) : []),
                ...memberIdsOf(command.workspace),
                ...occupantIdsOfDisplay(destDisplay),
              ]),
            );
            yield* executeCompound(affected, ({ intents, buffer, base }) => (w0) => {
              let w = moveWindowBetweenWorkspacesIn(w0, windowId, command.workspace, base);
              // skhd parity (skhdrc: "…and follow it to the destination"):
              // focus follows the moved window.
              w = { ...w, focusedWorkspace: command.workspace };
              buffer.push({ topic: "focus", payload: { workspace: command.workspace } });
              if (destDisplay !== null) {
                w = revealIn(w, intents, command.workspace, destDisplay);
                // When the destination kept its OWN display elsewhere, the
                // source stays visible with its remaining members — retile it.
                if (
                  sourceWs !== undefined &&
                  sourceWs.name !== command.workspace &&
                  destDisplay !== sourceDisplay
                ) {
                  intents.push({ kind: "retile", workspace: sourceWs.name });
                }
              }
              return w;
            });
            break;
          }
          case "moveFocusedWorkspaceToNextDisplay": {
            const wsName = world.focusedWorkspace;
            const ws = wsName === null ? undefined : world.workspaces.get(wsName);
            if (wsName === null || ws === undefined) {
              return yield* Effect.fail(
                new CommandError({ code: "workspace_not_found", message: "no focused workspace" }),
              );
            }
            const displays = world.topology.displays;
            if (displays.length === 0) {
              return yield* Effect.fail(
                new CommandError({
                  code: "topology_unstable",
                  message: "no connected displays",
                }),
              );
            }
            // A single display cycles onto itself: succeed without mutating.
            if (displays.length > 1) {
              const currentId =
                ws.visibleOnDisplay ?? ws.pinnedDisplayOverride ?? ws.preferredDisplay;
              // Canonical order = topology observation order (adapter-delivered).
              // An unknown/stale current display cycles to index 0.
              const currentIndex = displays.findIndex((d) => d.id === currentId);
              const next = displays[(currentIndex + 1 + displays.length) % displays.length]!;
              const displaced = [...world.workspaces.values()].find(
                (w) => w.name !== wsName && w.visibleOnDisplay === next.id,
              );
              const affected = Array.from(
                new Set([
                  ...memberIdsOf(wsName),
                  ...(displaced ? memberIdsOf(displaced.name) : []),
                  ...occupantIdsOfDisplay(next.id),
                ]),
              );
              yield* executeCompound(affected, ({ intents }) => (w0) => {
                let w = ensureWorkspaceIn(w0, wsName);
                w = {
                  ...w,
                  workspaces: new Map(w.workspaces).set(wsName, {
                    ...(w.workspaces.get(wsName)!),
                    pinnedDisplayOverride: next.id,
                  }),
                };
                void intents;
                return revealIn(w, intents, wsName, next.id);
              });
            } else {
              // Single-display cycle is a documented true no-op.
            }
            break;
          }
          case "focusDirection": {
            // Exclusive: origin resolution + focus + lastFocusedMember must
            // observe/apply authoritative signals atomically (issue 4).
            yield* runExclusive(
              Effect.gen(function* () {
                const ctx = yield* resolveDirectionContext();
                const originObs = world.windows.get(ctx.originId);
                if (originObs === undefined) {
                  return yield* Effect.fail(
                    new CommandError({
                      code: "window_not_found",
                      message: "focused window vanished",
                    }),
                  );
                }
                const neighborId = directionalNeighbor({
                  direction: command.direction,
                  origin: center(originObs.frame),
                  candidates: ctx.candidates,
                });
                if (neighborId === null) {
                  return yield* Effect.fail(
                    new CommandError({
                      code: "window_not_found",
                      message: `no other manageable window for direction ${command.direction}`,
                    }),
                  );
                }
                const applied = yield* Effect.either(
                  applyAction({ kind: "focusWindow", windowId: neighborId }),
                );
                if (applied._tag === "Left") {
                  return yield* Effect.fail(
                    new CommandError({
                      code: mapStepCode(applied.left.code),
                      message: applied.left.message,
                    }),
                  );
                }
                focusGeneration += 1;
                world = {
                  ...world,
                  focusIntent: { id: neighborId, generation: focusGeneration },
                };
                const ws = world.workspaces.get(ctx.workspaceName);
                if (ws !== undefined) commitWorkspace({ ...ws, lastFocusedMember: neighborId });
              }),
            );
            break;
          }
          case "moveDirection": {
            const ctx = yield* resolveDirectionContext();
            const workspaceNow = world.workspaces.get(ctx.workspaceName)!;
            const originObs = world.windows.get(ctx.originId);
            if (originObs === undefined) {
              return yield* Effect.fail(
                new CommandError({ code: "window_not_found", message: "focused window vanished" }),
              );
            }
            if (workspaceNow.floating.has(ctx.originId)) {
              return yield* Effect.fail(
                new CommandError({
                  code: "window_not_manageable",
                  message: "the focused window is floating; directional swaps require tiled windows",
                }),
              );
            }
            const neighborId = directionalNeighbor({
              direction: command.direction,
              origin: center(originObs.frame),
              candidates: ctx.candidates,
            });
            if (neighborId === null) {
              return yield* Effect.fail(
                new CommandError({
                  code: "window_not_found",
                  message: `no other manageable window for direction ${command.direction}`,
                }),
              );
            }
            if (workspaceNow.floating.has(neighborId)) {
              return yield* Effect.fail(
                new CommandError({
                  code: "window_not_manageable",
                  message: "the directional swap target is floating; floating windows are not swapped",
                }),
              );
            }
            // Transactional: the scoped plan (retile of THIS workspace only)
            // must verify before the tree commit becomes visible; on failure
            // or interruption nothing is committed and frames restore
            // identity-safely.
            yield* executeCompound(memberIdsOf(ctx.workspaceName), ({ intents }) => (w0) => {
              const wsNow = w0.workspaces.get(ctx.workspaceName)!;
              const tree = swapLeaves(wsNow.tree, ctx.originId, neighborId);
              intents.push({ kind: "retile", workspace: ctx.workspaceName });
              return {
                ...w0,
                workspaces: new Map(w0.workspaces).set(ctx.workspaceName, {
                  ...wsNow,
                  tree,
                  lastFocusedMember: ctx.originId,
                }),
              };
            });
            break;
          }
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
            const sourceWs = workspaceContaining(command.windowId);
            const affected = Array.from(
              new Set([
                command.windowId,
                ...(sourceWs ? memberIdsOf(sourceWs.name) : []),
                ...memberIdsOf(command.workspace),
              ]),
            );
            yield* executeCompound(affected, ({ intents, base }) => (w0) => {
              const w = moveWindowBetweenWorkspacesIn(w0, command.windowId, command.workspace, base);
              intents.push({ kind: "retile", workspace: command.workspace });
              if (
                sourceWs !== undefined &&
                sourceWs.name !== command.workspace &&
                sourceWs.visibleOnDisplay !== null
              ) {
                intents.push({ kind: "retile", workspace: sourceWs.name });
              }
              return w;
            });
            break;
          }
          case "focusWorkspace": {
            // NO live mutation here: a missing workspace is created only
            // inside the draft reducer (review round 3, issue 1). Displaced
            // occupants of the target display are captured up front.
            const prevName = world.focusedWorkspace;
            const existingNext = world.workspaces.get(command.name);
            const desiredDisplayPre = existingNext
              ? (existingNext.pinnedDisplayOverride ??
                existingNext.preferredDisplay ??
                primaryDisplay()?.id ??
                null)
              : (primaryDisplay()?.id ?? null);
            const affected = Array.from(
              new Set([
                ...memberIdsOf(prevName),
                ...(existingNext ? memberIdsOf(command.name) : []),
                ...occupantIdsOfDisplay(desiredDisplayPre),
              ]),
            );
            yield* executeCompound(affected, ({ intents, buffer }) => (w0) => {
              let w = ensureWorkspaceIn(w0, command.name);
              const nextWs = w.workspaces.get(command.name)!;
              const desiredDisplay =
                nextWs.pinnedDisplayOverride ??
                nextWs.preferredDisplay ??
                primaryDisplayIn(w)?.id ??
                null;
              w = { ...w, focusedWorkspace: command.name };
              buffer.push({ topic: "focus", payload: { workspace: command.name } });
              if (desiredDisplay !== null) {
                w = revealIn(w, intents, command.name, desiredDisplay);
              }
              return w;
            });
            break;
          }
          case "moveWorkspaceToDisplay": {
            const displaced = [...world.workspaces.values()].find(
              (w) => w.name !== command.workspace && w.visibleOnDisplay === command.displayId,
            );
            const affected = Array.from(
              new Set([
                ...memberIdsOf(command.workspace),
                ...(displaced ? memberIdsOf(displaced.name) : []),
                ...occupantIdsOfDisplay(command.displayId),
              ]),
            );
            yield* executeCompound(affected, ({ intents }) => (w0) => {
              let w = ensureWorkspaceIn(w0, command.workspace);
              w = {
                ...w,
                workspaces: new Map(w.workspaces).set(command.workspace, {
                  ...(w.workspaces.get(command.workspace)!),
                  pinnedDisplayOverride: command.displayId,
                }),
              };
              return revealIn(w, intents, command.workspace, command.displayId);
            });
            break;
          }
          case "setWorkspaceMode": {
            const ws = world.workspaces.get(command.workspace);
            if (ws !== undefined) commitWorkspace({ ...ws, mode: command.mode });
            yield* gatedReconcile();
            break;
          }
          case "retile": {
            // User-invoked STRICT scoped reconcile: retile every visible BSP
            // workspace (or the named one only). A NAMED workspace that does
            // not exist is a structured failure with no epoch/event bump
            // (review round 3, issue 7).
            if (command.workspace && !world.workspaces.has(command.workspace)) {
              return yield* Effect.fail(
                new CommandError({
                  code: "workspace_not_found",
                  message: `unknown workspace ${command.workspace}`,
                }),
              );
            }
            const targets = command.workspace
              ? [command.workspace]
              : [...world.workspaces.values()]
                  .filter((ws) => ws.visibleOnDisplay !== null)
                  .map((ws) => ws.name);
            const affected = Array.from(new Set(targets.flatMap((t) => memberIdsOf(t))));
            yield* executeCompound(affected, ({ intents }) => (w0) => {
              for (const t of targets) intents.push({ kind: "retile", workspace: t });
              return w0;
            });
            break;
          }
          case "reconcile":
            yield* gatedReconcile();
            break;
          case "focusWindow": {
            yield* runExclusive(
              Effect.gen(function* () {
                const applied = yield* Effect.either(
                  applyAction({ kind: "focusWindow", windowId: command.windowId }),
                );
                // Command stays success-tolerant (existing contract), but
                // engine focus intent records only REAL successes.
                if (applied._tag === "Right") {
                  focusGeneration += 1;
                  world = {
                    ...world,
                    focusIntent: { id: command.windowId, generation: focusGeneration },
                  };
                }
              }),
            );
            break;
          }
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

          // SINGLE event subscription (production adapter.events is a
          // single-consumer AsyncIterable): focus signals AND reconcile
          // requests are consumed from one ordered runForEach — never two
          // competing subscribers (review round 3 final, issue 1).
          fibers.push(
            yield* Stream.runForEach(adapter.events, (event) =>
              Effect.gen(function* () {
                if (event.kind === "focus_changed") consumeFocusSignal(event.windowId);
                yield* gatedReconcile();
              }),
            ).pipe(Effect.forkDaemon),
          );

          // Initial reconcile + rule pass (lenient at startup; diagnostics only).
          yield* Effect.ignore(runReconcile());

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
      setRecovery: (active: boolean) => queue.setRecovery(active),
      gateState: () => ({ busy: reconciling, rerunQueued: reconcileAgain }),
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
