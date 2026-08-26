import { Effect, Either, Fiber, Schema, Stream } from "effect";
import type { ConfigSource, PlatformAdapter, Clock } from "./platform.ts";
import {
  TopologyObservation,
  WindowObservation,
  windowIdentityFingerprint,
} from "./schema.ts";
import type {
  Constraints,
  DisplayId,
  DisplayObservation,
  ExpectedWindowIdentity,
  Frame,
  GeometryRequest,
  WindowId,
  WriteObservation,
  WorkspaceName,
} from "./schema.ts";
import type { DomainTopic } from "./events.ts";
import {
  classify,
  type BspNode,
  type ProfileKey,
  type ParkingCorner,
  type ParkingVisibility,
  type World,
  type WorkspaceState,
} from "./world.ts";
import {
  DEFAULT_TOLERANCE,
  EMPTY_TREE_LEAF,
  PARKING_ACCEPTANCE_PT,
  PROMOTION_SAMPLES,
} from "./constants.ts";
import { center, classifyWrite, containsPoint, withinTolerance } from "./geometry.ts";
import type { PlatformBatchOperation, PlatformBatchOperationResult } from "./platform.ts";
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
  setVerifiedConstraints,
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
import { insertionDisplay, insertionTargetFrame } from "./insertion-frame.ts";
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
import {
  learningFromObservationDocument,
  mergeLearningChanges,
  observationDocumentFromLearning,
  ObservationStoreError,
  type ObservationSnapshot,
  type ObservationStore,
} from "./observation-store.ts";

// Engine pipeline — docs/rewrite/engine-guide.md §Pipeline.
// Platform events are HINTS that trigger re-querying snapshots; rules produce
// an Action plan; the transaction executor applies actions via adapter
// primitives with verification; commits bump the World epoch and emit events.

export interface EngineOptions {
  adapter: PlatformAdapter;
  configSource: ConfigSource;
  clock: Clock;
  /** Optional durable learning boundary. Implementations live in the host. */
  observationStore?: ObservationStore;
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
    const { adapter, configSource, clock, observationStore } = options;

    const loadedObservations: Either.Either<ObservationSnapshot | null, ObservationStoreError> =
      observationStore === undefined
      ? Either.right(null)
      : yield* Effect.either(observationStore.load());
    let observationStoreFailed = loadedObservations._tag === "Left";
    let observationRevision = "memory";
    let initialLearning = emptyLearningStore();
    if (loadedObservations._tag === "Right" && loadedObservations.right !== null) {
      try {
        if (
          loadedObservations.right.revision.length === 0 ||
          loadedObservations.right.revision.length > 256
        ) {
          throw new ObservationStoreError("invalid", "observation revision is invalid");
        }
        initialLearning = learningFromObservationDocument(loadedObservations.right.document);
        observationRevision = loadedObservations.right.revision;
      } catch {
        observationStoreFailed = true;
      }
    }

    let world: World = {
      topology: { displays: [] },
      windows: new Map(),
      workspaces: new Map([["1", emptyWorkspace("1")]]),
      focusedWorkspace: "1",
      profiles: new Map(initialLearning.profiles),
      parkingFacts: [],
      paused: options.initiallyPaused ?? false,
      epoch: 0,
      focusIntent: null,
    };
    let config: Config = {};
    let learning: LearningStore = initialLearning;
    let persistedLearning: LearningStore = initialLearning;
    let learningDirty = false;
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
    let reconciling = false;
    let reconcileAgain = false;

    const setHealth = (next: HealthState, issue?: string): void => {
      if (issue !== undefined && !health.issues.includes(issue)) health.issues.push(issue);
      health.state = next;
      bus.publish("health", { state: next, issues: [...health.issues] });
    };
    if (observationStoreFailed) setHealth("degraded", "observation_store_unavailable");

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
      settings: (name, displayId) => effectiveSettings(config, name, displayId),
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

    const setLearning = (next: LearningStore): void => {
      if (next === learning) return;
      learning = next;
      learningDirty = true;
      syncProfiles();
    };

    const persistLearning = (): Effect.Effect<void, ObservationStoreError> => {
      if (!learningDirty || observationStore === undefined) {
        learningDirty = false;
        return Effect.void;
      }
      return Effect.gen(function* () {
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const base = persistedLearning;
          const local = learning;
          const document = yield* Effect.try({
            try: () => observationDocumentFromLearning(local),
            catch: (error) => error instanceof ObservationStoreError
              ? error
              : new ObservationStoreError("invalid", String(error)),
          });
          const saved = yield* Effect.either(observationStore.save(observationRevision, document));
          if (saved._tag === "Right") {
            const installed = yield* Effect.try({
              try: () => {
                if (saved.right.revision.length === 0 || saved.right.revision.length > 256) {
                  throw new ObservationStoreError("invalid", "observation revision is invalid");
                }
                return learningFromObservationDocument(saved.right.document);
              },
              catch: (error) => error instanceof ObservationStoreError
                ? error
                : new ObservationStoreError("invalid", String(error)),
            });
            learning = installed;
            persistedLearning = learning;
            observationRevision = saved.right.revision;
            learningDirty = false;
            observationStoreFailed = false;
            syncProfiles();
            return;
          }
          if (saved.left.code === "durability" && saved.left.committed !== undefined) {
            const committed = saved.left.committed;
            const installed = yield* Effect.try({
              try: () => {
                if (committed.revision.length === 0 || committed.revision.length > 256) {
                  throw new ObservationStoreError("invalid", "observation revision is invalid");
                }
                return learningFromObservationDocument(committed.document);
              },
              catch: (error) => error instanceof ObservationStoreError
                ? error
                : new ObservationStoreError("invalid", String(error)),
            });
            learning = installed;
            persistedLearning = installed;
            observationRevision = committed.revision;
            learningDirty = false;
            observationStoreFailed = true;
            syncProfiles();
            setHealth("degraded", "observation_store_durability");
            return;
          }
          if (saved.left.code === "busy" && attempt < 3) {
            yield* clock.sleep(25 * (attempt + 1));
            continue;
          }
          if (saved.left.code === "conflict" && attempt < 3) {
            const remoteSnapshot = yield* observationStore.load();
            const remote = yield* Effect.try({
              try: () => {
                if (remoteSnapshot.revision.length === 0 || remoteSnapshot.revision.length > 256) {
                  throw new ObservationStoreError("invalid", "observation revision is invalid");
                }
                return learningFromObservationDocument(remoteSnapshot.document);
              },
              catch: (error) => error instanceof ObservationStoreError
                ? error
                : new ObservationStoreError("invalid", String(error)),
            });
            learning = mergeLearningChanges(base, local, remote);
            persistedLearning = remote;
            observationRevision = remoteSnapshot.revision;
            learningDirty = true;
            reconcileAgain = true;
            syncProfiles();
            continue;
          }
          return yield* Effect.fail(saved.left);
        }
      });
    };

    const persistLearningBestEffort = (): Effect.Effect<void> =>
      Effect.catchAll(persistLearning(), (error) =>
        Effect.sync(() => {
          learning = persistedLearning;
          learningDirty = false;
          syncProfiles();
          observationStoreFailed = true;
          setHealth("degraded", `observation_store_${error.code}`);
        }));

    const installObservationSnapshot = (
      snapshot: ObservationSnapshot,
    ): Effect.Effect<boolean, ObservationStoreError> =>
      Effect.try({
        try: () => {
          if (snapshot.revision === observationRevision) return false;
          if (snapshot.revision.length === 0 || snapshot.revision.length > 256) {
            throw new ObservationStoreError("invalid", "observation revision is invalid");
          }
          learning = learningFromObservationDocument(snapshot.document);
          persistedLearning = learning;
          observationRevision = snapshot.revision;
          learningDirty = false;
          observationStoreFailed = false;
          syncProfiles();
          return true;
        },
        catch: (error) => error instanceof ObservationStoreError
          ? error
          : new ObservationStoreError("invalid", String(error)),
      });

    const learnFrom = (
      observation: WindowObservation,
      requested: Frame,
      outcome: "exact" | "constrained" | "stableClamp" | "progressing" | "failed",
      observed: Frame,
      samples = 1,
      confirmed = false,
      suppliedScan?: ReturnType<typeof candidatesFrom>,
    ): void => {
      const key = profileKeyOfObs(observation);
      if (key === null) return;
      if (outcome === "exact") {
        // Exact contradiction replaces a learned bound + resets pending.
        const result = noteExactFrame(learning, key, observed, 1);
        if (result.replaced.length > 0) setLearning(result.store);
        return;
      }
      if (outcome !== "constrained" && outcome !== "stableClamp") return;
      const scan =
        suppliedScan ??
        candidatesFrom({
          outcome,
          requested,
          observed,
          initial: firstSeen.get(observation.id) ?? observation.frame,
          workArea: workAreaFor(observation),
          tolerance: 1,
          confirmed,
        });
      if (scan.candidates.length > 0) {
        const evidenceSamples = confirmed ? Math.max(samples, PROMOTION_SAMPLES) : samples;
        let next = learning;
        for (let sample = 0; sample < evidenceSamples; sample += 1) {
          next = recordCandidates(next, key, scan.candidates).store;
        }
        setLearning(next);
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

    const syncConfiguredWorkspaces = (): void => {
      const workspaces = new Map(world.workspaces);
      const names = new Set([
        ...workspaces.keys(),
        ...(config.workspaces ?? []).map((workspace) => workspace.name),
      ]);
      for (const name of names) {
        const settings = effectiveSettings(config, name);
        const existing = workspaces.get(name) ?? emptyWorkspace(name);
        workspaces.set(name, {
          ...existing,
          mode: settings.mode,
          preferredDisplay: settings.preferredDisplay,
        });
      }
      world = { ...world, workspaces };
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
      const observedBesideFrame = beside === undefined ? undefined : world.windows.get(beside)?.frame;
      const insertionHost = insertionDisplay(world, workspace, observedBesideFrame);
      const besideFrame = insertionTargetFrame(
        world,
        workspace,
        observedBesideFrame,
        effectiveSettings(config, workspaceName, insertionHost?.id).margins,
      );

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
        tree: home.tree,
        parkedFrame: home.parkedFrames.get(windowId) ?? null,
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

    const writeFrame = (
      windowId: WindowId,
      frame: Frame,
      tolerance?: number,
      parkingDisplayId?: DisplayId,
      parkingDisplays = world.topology.displays,
    ) =>
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
          ...(parkingDisplayId !== undefined
            ? { acceptance: "parkingStablePositionClamp" as const }
            : {}),
        };
        const result = yield* Effect.either(
          applyGeometryRequest({ adapter, clock }, request, geometryContextFor(observation)),
        );
        if (result._tag === "Left") {
          // Resistant behavior marks cooperation (profile-informed skip ahead).
          const key = profileKeyOfObs(observation);
          if (key !== null) {
            setLearning(markCooperation(learning, key, true));
          }
          return yield* Effect.fail(stepFailure(result.left));
        }
        if (
          parkingDisplayId !== undefined &&
          (parkingDisplays.some((display) =>
            containsPoint(display.frame, center(result.right.frame)),
          ) ||
            !cornerFeasible(result.right.frame, parkingDisplayId, parkingDisplays))
        ) {
          return yield* Effect.fail<StepFailure>({
            code: "geometry_rejected",
            message: `window ${windowId} parking clamp intersects connected display topology`,
          });
        }
        learnFrom(
          observation,
          frame,
          result.right.outcome,
          result.right.frame,
          result.right.outcome === "stableClamp" ? result.right.attemptsUsed : 1,
          result.right.learningConfirmed,
          result.right.learning,
        );
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

          const result = yield* Effect.either(
            writeFrame(id, target, PARKING_ACCEPTANCE_PT, display.id),
          );
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
        const settings = effectiveSettings(config, workspaceName, display.id);
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
            // A startup inventory and its matching window_added event can plan
            // concurrently. Preserve the first committed membership.
            if (workspaceContaining(action.windowId) !== undefined) return;
            {
              const tombstone = tombstones.get(action.windowId);
              const observation = world.windows.get(action.windowId);
              if (
                tombstone !== undefined &&
                observation !== undefined &&
                tombstone.workspace === action.workspace &&
                observation.id === action.windowId
              ) {
                const workspace = ensureWorkspace(action.workspace);
                const surviving = tiledMembers(tombstone.tree).filter((id) => id !== action.windowId);
                if (
                  !tombstone.floating &&
                  surviving.length === tiledMembers(workspace.tree).length &&
                  surviving.every((id) => tiledMembers(workspace.tree).includes(id))
                ) {
                  commitWorkspace({
                    ...workspace,
                    tree: tombstone.tree,
                    lastFocusedMember: action.windowId,
                    parkedFrames:
                      tombstone.parkedFrame === null
                        ? workspace.parkedFrames
                        : new Map(workspace.parkedFrames).set(action.windowId, tombstone.parkedFrame),
                  });
                  tombstones.delete(action.windowId);
                  return;
                }
              }
            }
            if (action.floating === true) {
              const workspace = ensureWorkspace(action.workspace);
              commitWorkspace({
                ...workspace,
                floating: new Set(workspace.floating).add(action.windowId),
                parkedFrames: (() => {
                  const frame = tombstones.get(action.windowId)?.parkedFrame;
                  return frame == null
                    ? workspace.parkedFrames
                    : new Map(workspace.parkedFrames).set(action.windowId, frame);
                })(),
              });
            } else {
              insertTiledInto(action.workspace, action.windowId, action.beside ?? null);
            }
            tombstones.delete(action.windowId);
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
        yield* persistLearningBestEffort();
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

        if (windowsResult.right.length === 0 && world.windows.size > 0 && topology.right.displays.length > 0) {
          setHealth("degraded", "inventory_stale");
          bus.publish("diagnostic", {
            code: "inventory_unavailable",
            detail: "ignored transient full-zero window inventory",
          });
          return;
        }

        for (const [id, tombstone] of tombstones) {
          if (clock.now() - tombstone.at > TOMBSTONE_TTL_MS) tombstones.delete(id);
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
        if (health.state === "degraded" && !observationStoreFailed) setHealth("healthy");
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

    interface PlannedWrite {
      readonly windowId: WindowId;
      readonly frame: Frame;
      readonly tolerance?: number | undefined;
      readonly parkingWorkspace?: WorkspaceName | undefined;
      readonly parkingDisplayId?: DisplayId | undefined;
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
      const observedBesideFrame =
        beside === undefined ? undefined : framesWorld.windows.get(beside)?.frame;
      const insertionHost = insertionDisplay(withWs, ws, observedBesideFrame);
      const besideFrame = insertionTargetFrame(
        withWs,
        ws,
        observedBesideFrame,
        effectiveSettings(config, wsName, insertionHost?.id).margins,
      );
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
      const destinationExisted = next.workspaces.has(workspaceName);
      next = ensureWorkspaceIn(next, workspaceName);
      if (!destinationExisted) {
        const created = next.workspaces.get(workspaceName)!;
        next = {
          ...next,
          workspaces: new Map(next.workspaces).set(workspaceName, {
            ...created,
            visibleOnDisplay: null,
          }),
        };
      }
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
      settingsFor(name: string, displayId?: DisplayId): EffectiveWorkspaceSettings;
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
        const settings = acc.settingsFor(wsName, display.id);
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
          writes.push({
            windowId: id,
            frame: target,
            tolerance: PARKING_ACCEPTANCE_PT,
            parkingWorkspace: wsName,
            parkingDisplayId: display.id,
          });
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
      learning: LearningStore;
      persistedLearning: LearningStore;
      observationRevision: string;
      observationStoreFailed: boolean;
      learningDirty: boolean;
      committed: boolean;
      appliedActions: number;
    }

    const rollbackCompound = (ctx: CompoundCtx): Effect.Effect<void> =>
      Effect.gen(function* () {
        learning = ctx.learning;
        persistedLearning = ctx.persistedLearning;
        observationRevision = ctx.observationRevision;
        observationStoreFailed = ctx.observationStoreFailed;
        learningDirty = ctx.learningDirty;
        syncProfiles();
        let incomplete = false;
        for (const cap of [...ctx.preFrames].reverse()) {
          const observedNow = yield* Effect.either(adapter.getWindow(cap.id));
          if (observedNow._tag === "Left" || observedNow.right === null) {
            incomplete = true;
            continue;
          }
          if (windowIdentityFingerprint(observedNow.right) !== cap.identity) {
            incomplete = true;
            bus.publish("diagnostic", {
              code: "rollback_identity_changed",
              detail: `window ${cap.id}: replacement detected; compensation skipped`,
            });
            continue;
          }
          if (withinTolerance(observedNow.right.frame, cap.frame, DEFAULT_TOLERANCE)) continue;
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
          if (!withinTolerance(written.right.observed, cap.frame, DEFAULT_TOLERANCE)) {
            incomplete = true;
          }
        }
        if (incomplete) setHealth("degraded", "rollback_incomplete");
      });

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
      validateDraft?: (draft: World) => CommandError | null,
      focusAfter?: (draft: World) => WindowId | null,
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
            const identity = windowIdentityFingerprint(captured);
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
            learning,
            persistedLearning,
            observationRevision,
            observationStoreFailed,
            learningDirty,
            committed: false,
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
              const draftError = validateDraft?.(ctx.draft) ?? null;
              if (draftError !== null) return yield* Effect.fail(draftError);
              ctx.draft = reduce({ intents: ctx.intents, buffer: ctx.events, base: world })(
                ctx.draft,
              );
              const built = buildCompoundPlan(ctx.draft, ctx.intents, {
                observationOf: (id) => ctx.draft.windows.get(id),
                constraintsFor: (obs) => constraintsFor(obs),
                settingsFor: (name, displayId) => effectiveSettings(config, name, displayId),
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
              let finalDraft = built.draft;
              const captured = new Map(ctx.preFrames.map((frame) => [frame.id, frame]));
              const writeOperations: PlatformBatchOperation[] = built.writes.map((wr, index) => ({
                operationId: `write:${index}:${wr.windowId}`,
                kind: "setFrame",
                windowId: wr.windowId,
                frame: wr.frame,
                expectedIdentity: captured.get(wr.windowId)!.expected,
              }));
              const focusId = focusAfter?.(built.draft) ?? null;
              const focusCapture = focusId === null ? undefined : captured.get(focusId);
              const operations: PlatformBatchOperation[] = [
                ...writeOperations,
                ...(focusId !== null && focusCapture !== undefined
                  ? [{
                      operationId: `focus:${focusId}`,
                      kind: "focus" as const,
                      windowId: focusId,
                      expectedIdentity: focusCapture.expected,
                      dependsOn: writeOperations
                        .filter((operation) => operation.windowId === focusId)
                        .map((operation) => operation.operationId),
                    }]
                  : []),
              ];
              const sequentialBatch = () =>
                Effect.gen(function* () {
                  const results: PlatformBatchOperationResult[] = [];
                  for (const operation of operations) {
                    const outcome = yield* Effect.either(
                      operation.kind === "setFrame"
                        ? adapter.setWindowFrame(operation.windowId, operation.frame, operation.expectedIdentity)
                        : Effect.as(adapter.focusWindow(operation.windowId), undefined),
                    );
                    if (outcome._tag === "Left") {
                      results.push({ operationId: operation.operationId, error: outcome.left });
                    } else if (operation.kind === "focus") {
                      results.push({ operationId: operation.operationId });
                    } else {
                      const write = outcome.right as WriteObservation;
                      results.push({
                        operationId: operation.operationId,
                        requested: write.requested,
                        observed: write.observed,
                        stable: write.stable,
                      });
                    }
                  }
                  return {
                    operations: results,
                    completed: results.filter((result) => result.error === undefined).length,
                    failed: results.filter((result) => result.error !== undefined).length,
                  };
                });
              const batch = yield* Effect.mapError(
                operations.length === 0
                  ? Effect.succeed({ operations: [], completed: 0, failed: 0 })
                  : (adapter.executeBatch?.({ operations }) ?? sequentialBatch()),
                (error) => new CommandError({ code: mapStepCode(error.code), message: error.detail ?? "native batch failed" }),
              );
              for (let index = 0; index < built.writes.length; index += 1) {
                const wr = built.writes[index]!;
                const batchResult = batch.operations[index]!;
                if (batchResult.error !== undefined) {
                  return yield* Effect.fail(new CommandError({
                    code: mapStepCode(batchResult.error.code),
                    message: `window ${wr.windowId}: ${batchResult.error.detail ?? "native batch operation failed"}`,
                  }));
                }
                const observation = finalDraft.windows.get(wr.windowId)!;
                const observed = batchResult.observed ?? observation.frame;
                const tolerance = wr.tolerance ?? DEFAULT_TOLERANCE;
                const classifiedOutcome = classifyWrite({
                  requested: wr.frame,
                  observed,
                  tolerance,
                  stable: batchResult.stable ?? false,
                  constraints: constraintsFor(observation),
                  initialFrame: firstSeen.get(wr.windowId) ?? observation.frame,
                  previousObserved: observation.frame,
                  acceptStablePositionClamp: wr.parkingDisplayId !== undefined,
                });
                const nativeConfirmedSizeClamp =
                  (batchResult.stableReads ?? 0) >= 3 &&
                  observation.capabilities.resizable === "supported" &&
                  Math.abs(observed.x - wr.frame.x) <= tolerance &&
                  Math.abs(observed.y - wr.frame.y) <= tolerance &&
                  (Math.abs(observed.width - wr.frame.width) > tolerance ||
                    Math.abs(observed.height - wr.frame.height) > tolerance);
                const outcome = nativeConfirmedSizeClamp ? "stableClamp" : classifiedOutcome;
                const confirmedStableClamp =
                  outcome === "stableClamp" && nativeConfirmedSizeClamp;
                const parkingSafe = wr.parkingDisplayId === undefined || (
                  !finalDraft.topology.displays.some((display) =>
                    containsPoint(display.frame, center(observed))) &&
                  cornerFeasible(observed, wr.parkingDisplayId, finalDraft.topology.displays)
                );
                const acceptedInitial = parkingSafe && (
                  outcome === "exact" || outcome === "constrained" ||
                  (outcome === "stableClamp" &&
                    (wr.parkingDisplayId !== undefined || confirmedStableClamp))
                );
                const result = acceptedInitial
                  ? { _tag: "Right" as const, right: { frame: observed, outcome } }
                  : yield* Effect.either(writeFrame(
                      wr.windowId, wr.frame, wr.tolerance, wr.parkingDisplayId,
                      finalDraft.topology.displays,
                    ));
                if (result._tag === "Left") {
                  return yield* Effect.fail(
                    new CommandError({
                      code: mapStepCode(result.left.code),
                      message: `window ${wr.windowId}: ${result.left.message}; target=${JSON.stringify(wr.frame)}${result.left.diagnostic === undefined ? "" : `; ${result.left.diagnostic}`}`,
                    }),
                  );
                }
                if (observation !== undefined) {
                  if (acceptedInitial) {
                    learnFrom(
                      observation,
                      wr.frame,
                      outcome,
                      observed,
                      confirmedStableClamp ? batchResult.stableReads : 1,
                      confirmedStableClamp,
                    );
                  }
                  finalDraft = {
                    ...finalDraft,
                    windows: new Map(finalDraft.windows).set(wr.windowId, {
                      ...observation,
                      frame: result.right.frame,
                    }),
                  };
                }
                if (wr.parkingWorkspace !== undefined) {
                  const workspace = finalDraft.workspaces.get(wr.parkingWorkspace);
                  if (workspace !== undefined) {
                    finalDraft = {
                      ...finalDraft,
                      workspaces: new Map(finalDraft.workspaces).set(wr.parkingWorkspace, {
                        ...workspace,
                        parkedFrames: new Map(workspace.parkedFrames).set(
                          wr.windowId,
                          result.right.frame,
                        ),
                      }),
                    };
                  }
                }
                applied += 1;
              }
              const focusResult = batch.operations[built.writes.length];
              if (focusResult?.error !== undefined) {
                return yield* Effect.fail(new CommandError({
                  code: mapStepCode(focusResult.error.code),
                  message: focusResult.error.detail ?? `focus ${focusId} failed`,
                }));
              }
              if (focusId !== null && focusResult !== undefined) {
                focusGeneration += 1;
                finalDraft = { ...finalDraft, focusIntent: { id: focusId, generation: focusGeneration } };
                const focusedWorkspace = finalDraft.focusedWorkspace === null
                  ? undefined : finalDraft.workspaces.get(finalDraft.focusedWorkspace);
                if (focusedWorkspace !== undefined) {
                  finalDraft = {
                    ...finalDraft,
                    workspaces: new Map(finalDraft.workspaces).set(focusedWorkspace.name, {
                      ...focusedWorkspace, lastFocusedMember: focusId,
                    }),
                  };
                }
                applied += 1;
              }
              ctx.appliedActions = applied;
              ctx.finalDraft = finalDraft;
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* Effect.mapError(
                    persistLearning(),
                    (error) => new CommandError({
                      code: "internal_error",
                      message: `observation persistence failed: ${error.message}`,
                    }),
                  );
                  ctx.committed = true;
                }),
              );
              return ctx.draft;
            }),
            (exit) =>
              Effect.gen(function* () {
                if (exit._tag === "Success" || ctx.committed) {
                  world = {
                    ...ctx.finalDraft,
                    profiles: new Map(learning.profiles),
                    epoch: ctx.finalDraft.epoch + 1,
                  };
                  for (const event of ctx.events) bus.publish(event.topic, event.payload);
                  bus.publish("reconciliation", {
                    epoch: world.epoch,
                    plannedActions: ctx.appliedActions,
                    appliedSteps: ctx.appliedActions,
                  });
                  return;
                }
                yield* rollbackCompound(ctx);
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
        const candidate = mode === "delta" ? applyConfigDelta(config, raw) : applyConfigFull(config, raw);
        if (configSource.prepare !== undefined) {
          const prepared = yield* Effect.either(configSource.prepare(candidate, mode));
          if (prepared._tag === "Left") {
            setHealth("degraded", "config_invalid");
            bus.publish("config", { status: "invalid", issues: prepared.left.issues.slice(0, 4) });
            return { type: "configChecked", valid: false, issues: [...prepared.left.issues] };
          }
        }
        config = candidate;
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

    const probeWindowLimits = (windowId: WindowId): Effect.Effect<CommandResult, CommandError> =>
      runExclusive(
        Effect.gen(function* () {
          const initial = yield* Effect.mapError(adapter.getWindow(windowId), (error) =>
            new CommandError({ code: mapStepCode(error.code), message: error.detail ?? "window read failed" }),
          );
          if (initial === null) {
            return yield* Effect.fail(new CommandError({
              code: "window_not_found",
              message: `unknown window ${windowId}`,
            }));
          }
          if (initial.hidden || initial.minimized || initial.fullscreen) {
            return yield* Effect.fail(new CommandError({
              code: "window_not_controllable",
              message: `window ${windowId} must be non-hidden, non-minimized, and non-fullscreen`,
            }));
          }
          if (classify(initial) !== "normal") {
            return yield* Effect.fail(new CommandError({
              code: "window_not_controllable",
              message: `window ${windowId} is not a controllable normal window`,
            }));
          }

          const identity = windowIdentityFingerprint(initial);
          const expected: ExpectedWindowIdentity = { fingerprint: identity };
          const originalFrame = { ...initial.frame };
          let restorationPending = false;
          let expectedPhysicalFrame = originalFrame;
          const topology = yield* Effect.mapError(validatedTopology(), (message) =>
            new CommandError({ code: "topology_unstable", message }),
          );
          if (topology.displays.length === 0) {
            return yield* Effect.fail(new CommandError({
              code: "topology_unstable",
              message: "no connected display work areas",
            }));
          }
          const maxTestWidth = Math.max(...topology.displays.map((display) => display.workArea.width));
          const maxTestHeight = Math.max(...topology.displays.map((display) => display.workArea.height));
          const topologyKey = JSON.stringify(topology.displays);
          const topologyFingerprint = contextFingerprint(topology);
          const parkedWorkspace = [...world.workspaces.values()].find(
            (workspace) => workspace.visibleOnDisplay === null && workspace.parkedFrames.has(windowId),
          );
          const durableParkedFrame = parkedWorkspace?.parkedFrames.get(windowId);
          const parkedCandidates: Array<{
            display: DisplayObservation;
            corner: ParkingCorner;
            visibility: ParkingVisibility;
          }> = [];
          if (durableParkedFrame !== undefined) {
            for (const display of topology.displays) {
              for (const corner of CORNER_PRIORITY) {
                const fact =
                  findParkingFact(world.parkingFacts, display, corner) ??
                  world.parkingFacts.find(
                    (candidate) =>
                      candidate.displayId === display.id &&
                      candidate.corner === corner &&
                      candidate.fingerprint === factFingerprint(display),
                  ) ??
                  null;
                if (
                  fact !== null &&
                  withinTolerance(
                    cornerTarget(display, corner, durableParkedFrame, fact.visibility),
                    durableParkedFrame,
                    DEFAULT_TOLERANCE,
                  ) &&
                  cornerFeasible(durableParkedFrame, display.id, topology.displays)
                ) {
                  parkedCandidates.push({ display, corner, visibility: fact.visibility });
                }
              }
            }
            if (parkedCandidates.length !== 1) {
              return yield* Effect.fail(new CommandError({
                code: "geometry_verification_failed",
                message: `durable parked intent for ${windowId} cannot be attributed safely`,
              }));
            }
          }
          const parked = parkedCandidates[0];
          const parkedWorkspaceName = parkedWorkspace?.name;
          const exactFrame = (a: Frame, b: Frame): boolean =>
            a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
          if (parked === undefined) {
            return yield* Effect.fail(new CommandError({
              code: "window_not_controllable",
              message: `window ${windowId} must have uniquely attributable durable parked intent`,
            }));
          }

          type SampleName = "capabilityWidth" | "capabilityHeight" | "minWidth" | "minHeight" | "maxWidth" | "maxHeight";
          type PositionDiagnostic = {
            sample: SampleName;
            correction: "verified" | "clamped";
            requestedIdealPoint: { x: number; y: number };
            observedPoint: { x: number; y: number };
            idealRetainedVisibility: ParkingVisibility;
            actualRetainedVisibility: ParkingVisibility;
          };
          const retainedVisibility = (frame: Frame): ParkingVisibility => {
            const maxX = parked.display.frame.x + parked.display.frame.width;
            const maxY = parked.display.frame.y + parked.display.frame.height;
            const left = parked.corner === "bottomLeft" || parked.corner === "topLeft";
            const bottom = parked.corner === "bottomLeft" || parked.corner === "bottomRight";
            return {
              horizontal: left ? frame.x + frame.width - parked.display.frame.x : maxX - frame.x,
              vertical: bottom ? maxY - frame.y : frame.y + frame.height - parked.display.frame.y,
            };
          };
          const safelyParked = (frame: Frame): boolean => {
            const visibility = retainedVisibility(frame);
            const midpoint = center(frame);
            const centerOnDisplay = topology.displays.some((display) =>
              midpoint.x >= display.frame.x && midpoint.x <= display.frame.x + display.frame.width &&
              midpoint.y >= display.frame.y && midpoint.y <= display.frame.y + display.frame.height);
            const overlapsOtherDisplay = topology.displays.some((display) => display.id !== parked.display.id &&
              Math.max(0, Math.min(frame.x + frame.width, display.frame.x + display.frame.width) - Math.max(frame.x, display.frame.x)) *
                Math.max(0, Math.min(frame.y + frame.height, display.frame.y + display.frame.height) - Math.max(frame.y, display.frame.y)) > 0);
            const endpointKeepsCenterOffDisplay =
              visibility.horizontal <= frame.width || visibility.vertical <= frame.height;
            return visibility.horizontal > 0 && visibility.vertical > 0 &&
              (visibility.horizontal <= frame.width || frame.width <= parked.visibility.horizontal) &&
              (visibility.vertical <= frame.height || frame.height <= parked.visibility.vertical) &&
              !centerOnDisplay && !overlapsOtherDisplay && endpointKeepsCenterOffDisplay &&
              cornerFeasible(frame, parked.display.id, topology.displays);
          };

          const verifyGuards = (): Effect.Effect<void, CommandError> =>
            Effect.gen(function* () {
              const currentTopology = yield* Effect.mapError(validatedTopology(), (message) =>
                new CommandError({ code: "topology_unstable", message }),
              );
              if (JSON.stringify(currentTopology.displays) !== topologyKey) {
                return yield* Effect.fail(new CommandError({
                  code: "topology_unstable",
                  message: "display topology changed during limit probe",
                }));
              }
              if (contextFingerprint(world.topology) !== topologyFingerprint ||
                JSON.stringify(world.topology.displays) !== topologyKey) {
                return yield* Effect.fail(new CommandError({
                  code: "topology_unstable",
                  message: "committed topology no longer matches the captured probe topology",
                }));
              }
              const currentWorkspace = parkedWorkspaceName === undefined
                ? undefined
                : world.workspaces.get(parkedWorkspaceName);
              const currentDurableFrame = currentWorkspace?.parkedFrames.get(windowId);
              const currentParkingFact = world.parkingFacts.find((fact) =>
                fact.displayId === parked.display.id && fact.corner === parked.corner &&
                fact.fingerprint === factFingerprint(parked.display));
              if (currentWorkspace === undefined || currentWorkspace.visibleOnDisplay !== null ||
                (!tiledMembers(currentWorkspace.tree).includes(windowId) && !currentWorkspace.floating.has(windowId)) ||
                currentDurableFrame === undefined || !exactFrame(currentDurableFrame, durableParkedFrame!) ||
                currentParkingFact === undefined ||
                currentParkingFact.visibility.horizontal !== parked.visibility.horizontal ||
                currentParkingFact.visibility.vertical !== parked.visibility.vertical ||
                !exactFrame(cornerTarget(parked.display, parked.corner, currentDurableFrame, currentParkingFact.visibility), currentDurableFrame)) {
                return yield* Effect.fail(new CommandError({
                  code: "inventory_stale",
                  message: `workspace membership, visibility, parked intent, or parking fact for ${windowId} changed during limit probe`,
                }));
              }
            });

          const readSame = (
            checkDiagnosticGuards = true,
            requiredFrame?: Frame,
          ): Effect.Effect<WindowObservation, CommandError> =>
            Effect.gen(function* () {
              if (checkDiagnosticGuards) yield* verifyGuards();
              const observation = yield* Effect.mapError(adapter.getWindow(windowId), (error) =>
                new CommandError({ code: mapStepCode(error.code), message: error.detail ?? "window read failed" }),
              );
              if (observation === null || windowIdentityFingerprint(observation) !== identity) {
                return yield* Effect.fail(new CommandError({
                  code: "inventory_stale",
                  message: `window ${windowId} identity changed during limit probe`,
                }));
              }
              if (checkDiagnosticGuards && (observation.hidden || observation.minimized || observation.fullscreen ||
                classify(observation) !== "normal" || observation.capabilities.movable === "fixed" ||
                observation.capabilities.resizable === "fixed")) {
                return yield* Effect.fail(new CommandError({
                  code: "window_not_controllable",
                  message: `window ${windowId} became hidden, minimized, fullscreen, non-normal, or fixed during limit probe`,
                }));
              }
              if (requiredFrame !== undefined && !exactFrame(observation.frame, requiredFrame)) {
                return yield* Effect.fail(new CommandError({
                  code: "inventory_stale",
                  message: `window ${windowId} physical frame drifted during limit probe`,
                }));
              }
              return observation;
            });

          const writeAndRead = (frame: Frame, checkDiagnosticGuards = true): Effect.Effect<Frame, CommandError> =>
            Effect.gen(function* () {
              yield* readSame(checkDiagnosticGuards, expectedPhysicalFrame);
              restorationPending = true;
              const write = yield* Effect.mapError(adapter.setWindowFrame(windowId, frame, expected), (error) =>
                new CommandError({ code: mapStepCode(error.code), message: error.detail ?? "probe write failed" }),
              );
              if (!write.stable) {
                return yield* Effect.fail(new CommandError({
                  code: "geometry_verification_failed",
                  message: `window ${windowId} did not settle during limit probe`,
                }));
              }
              const observed = (yield* readSame(checkDiagnosticGuards)).frame;
              expectedPhysicalFrame = observed;
              return observed;
            });

          const restore = (): Effect.Effect<Frame, CommandError> =>
            Effect.gen(function* () {
              yield* readSame(false);
              const write = yield* Effect.mapError(adapter.setWindowFrame(windowId, originalFrame, expected), (error) =>
                new CommandError({ code: mapStepCode(error.code), message: error.detail ?? "restore write failed" }));
              if (!write.stable) {
                return yield* Effect.fail(new CommandError({
                  code: "geometry_verification_failed",
                  message: `window ${windowId} did not settle while restoring the limit probe`,
                }));
              }
              const restored = (yield* readSame(false)).frame;
              if (!exactFrame(restored, originalFrame)) {
                return yield* Effect.fail(new CommandError({
                  code: "geometry_verification_failed",
                  message: `failed to restore window ${windowId} after limit probe`,
                }));
              }
              expectedPhysicalFrame = originalFrame;
              restorationPending = false;
              return restored;
            });

          const sample = (
            name: SampleName,
            size: { width: number; height: number },
          ): Effect.Effect<{ frame: Frame; diagnostic: PositionDiagnostic }, CommandError> =>
            Effect.gen(function* () {
              const trialVisibility = {
                horizontal: Math.min(parked.visibility.horizontal, size.width),
                vertical: Math.min(parked.visibility.vertical, size.height),
              };
              const requested = cornerTarget(parked.display, parked.corner, size, trialVisibility);
              if (!cornerFeasible(requested, parked.display.id, topology.displays)) {
                return yield* Effect.fail(new CommandError({
                  code: "geometry_verification_failed",
                  message: `parked trial for ${windowId} would overlap another display`,
                }));
              }
              const outcome = yield* Effect.either(Effect.gen(function* () {
                const observed = yield* writeAndRead(requested);
                const probesWidth = name === "capabilityWidth" || name === "minWidth" || name === "maxWidth";
                if ((probesWidth && observed.height !== size.height) || (!probesWidth && observed.width !== size.width)) {
                  return yield* Effect.fail(new CommandError({
                    code: "geometry_verification_failed",
                    message: `limit probe changed the orthogonal dimension for ${windowId}`,
                  }));
                }
                const correctedTarget = cornerTarget(parked.display, parked.corner, observed, {
                  horizontal: Math.min(parked.visibility.horizontal, observed.width),
                  vertical: Math.min(parked.visibility.vertical, observed.height),
                });
                if (!cornerFeasible(correctedTarget, parked.display.id, topology.displays)) {
                  return yield* Effect.fail(new CommandError({
                    code: "geometry_verification_failed",
                    message: `clamped parked trial for ${windowId} would overlap another display`,
                  }));
                }
                yield* readSame();
                const correction = yield* Effect.mapError(
                  adapter.setWindowPosition(
                    windowId,
                    { x: correctedTarget.x, y: correctedTarget.y },
                    expected,
                  ),
                  (error) => new CommandError({
                    code: mapStepCode(error.code),
                    message: error.detail ?? "parking correction failed",
                  }),
                );
                if (!correction.stable) {
                  return yield* Effect.fail(new CommandError({
                    code: "geometry_verification_failed",
                    message: `window ${windowId} did not settle after parking correction`,
                  }));
                }
                const corrected = (yield* readSame()).frame;
                if (corrected.width !== observed.width || corrected.height !== observed.height) {
                  return yield* Effect.fail(new CommandError({
                    code: "geometry_verification_failed",
                    message: `parking correction changed measured dimensions for ${windowId}`,
                  }));
                }
                if (!safelyParked(corrected)) {
                  return yield* Effect.fail(new CommandError({
                    code: "geometry_verification_failed",
                    message: `parking correction moved ${windowId} onscreen, to another corner, or across displays`,
                  }));
                }
                const correctionStatus = exactFrame(corrected, correctedTarget) ? "verified" as const : "clamped" as const;
                return {
                  frame: corrected,
                  diagnostic: {
                    sample: name,
                    correction: correctionStatus,
                    requestedIdealPoint: { x: correctedTarget.x, y: correctedTarget.y },
                    observedPoint: { x: corrected.x, y: corrected.y },
                    idealRetainedVisibility: trialVisibility,
                    actualRetainedVisibility: retainedVisibility(corrected),
                  },
                };
              }));
              const restored = yield* Effect.either(restore());
              if (restored._tag === "Left") {
                return yield* Effect.fail(new CommandError({
                  code: "geometry_verification_failed",
                  message: `limit probe aborted and original frame restoration failed: ${restored.left.message}`,
                }));
              }
              if (outcome._tag === "Left") return yield* Effect.fail(outcome.left);
              return outcome.right;
            });

          return yield* Effect.onExit(Effect.gen(function* () {
          if (!exactFrame(initial.frame, durableParkedFrame!) || !safelyParked(initial.frame)) {
            return yield* Effect.fail(new CommandError({
              code: "inventory_stale",
              message: `window ${windowId} is no longer physically parked at its durable frame`,
            }));
          }
          const positionNudge = {
            x: originalFrame.x + (parked.corner === "bottomLeft" || parked.corner === "topLeft" ? 1 : -1),
            y: originalFrame.y + (parked.corner === "bottomLeft" || parked.corner === "bottomRight" ? -1 : 1),
          };
          yield* readSame(true, expectedPhysicalFrame);
          restorationPending = true;
          const positionWrite = yield* Effect.mapError(
            adapter.setWindowPosition(windowId, positionNudge, expected),
            (error) => new CommandError({ code: mapStepCode(error.code), message: error.detail ?? "capability position write failed" }),
          );
          const positionObserved = (yield* readSame()).frame;
          expectedPhysicalFrame = positionObserved;
          const positionSupported = positionWrite.stable && positionObserved.x === positionNudge.x &&
            positionObserved.y === positionNudge.y && positionObserved.width === originalFrame.width &&
            positionObserved.height === originalFrame.height && safelyParked(positionObserved);
          const capabilityRestore = yield* Effect.either(restore());
          if (capabilityRestore._tag === "Left") {
            return yield* Effect.fail(new CommandError({
              code: "geometry_verification_failed",
              message: `capability probe aborted and original frame restoration failed: ${capabilityRestore.left.message}`,
            }));
          }
          if (!positionSupported) {
            return yield* Effect.fail(new CommandError({
              code: "window_not_controllable",
              message: `parked behavioral capability probe found fixed or inconclusive positioning for ${windowId}`,
            }));
          }

          let capabilityWidth = yield* sample("capabilityWidth", { width: Math.max(1, originalFrame.width - 1), height: originalFrame.height });
          if (capabilityWidth.frame.width === originalFrame.width) {
            capabilityWidth = yield* sample("capabilityWidth", { width: originalFrame.width + 1, height: originalFrame.height });
          }
          let capabilityHeight = yield* sample("capabilityHeight", { width: originalFrame.width, height: Math.max(1, originalFrame.height - 1) });
          if (capabilityHeight.frame.height === originalFrame.height) {
            capabilityHeight = yield* sample("capabilityHeight", { width: originalFrame.width, height: originalFrame.height + 1 });
          }
          const widthResizable = capabilityWidth.frame.width !== originalFrame.width && capabilityWidth.frame.height === originalFrame.height;
          const heightResizable = capabilityHeight.frame.height !== originalFrame.height && capabilityHeight.frame.width === originalFrame.width;
          if (!widthResizable || !heightResizable) {
            return yield* Effect.fail(new CommandError({
              code: "window_not_controllable",
              message: `parked behavioral capability probe found fixed or inconclusive sizing for ${windowId}`,
            }));
          }
          const minWidth = yield* sample("minWidth", { width: 1, height: originalFrame.height });
          const minHeight = yield* sample("minHeight", { width: originalFrame.width, height: 1 });
          const maxWidthSample = yield* sample("maxWidth", { width: maxTestWidth, height: originalFrame.height });
          const maxHeightSample = yield* sample("maxHeight", { width: originalFrame.width, height: maxTestHeight });
          const minWidthFrame = minWidth.frame;
          const minHeightFrame = minHeight.frame;
          const maxWidthFrame = maxWidthSample.frame;
          const maxHeightFrame = maxHeightSample.frame;
          const positionDiagnostics = [
            capabilityWidth.diagnostic,
            capabilityHeight.diagnostic,
            minWidth.diagnostic,
            minHeight.diagnostic,
            maxWidthSample.diagnostic,
            maxHeightSample.diagnostic,
          ];
          const restoredFrame = (yield* readSame()).frame;
          if (!exactFrame(restoredFrame, originalFrame)) {
            return yield* Effect.fail(new CommandError({
              code: "geometry_verification_failed",
              message: `window ${windowId} was not restored after limit probe`,
            }));
          }

          const minWidthFinding = minWidthFrame.width === 1
            ? ({ kind: "noClampDownTo", value: 1 } as const)
            : ({ kind: "exact", value: minWidthFrame.width } as const);
          const minHeightFinding = minHeightFrame.height === 1
            ? ({ kind: "noClampDownTo", value: 1 } as const)
            : ({ kind: "exact", value: minHeightFrame.height } as const);
          const maxWidth = maxWidthFrame.width < maxTestWidth
            ? ({ kind: "exact", value: maxWidthFrame.width } as const)
            : ({ kind: "noClampThrough", value: maxTestWidth } as const);
          const maxHeight = maxHeightFrame.height < maxTestHeight
            ? ({ kind: "exact", value: maxHeightFrame.height } as const)
            : ({ kind: "noClampThrough", value: maxTestHeight } as const);
          const application = initial.bundleId ?? initial.executablePath;
          const key: ProfileKey | null = application === undefined ? null : {
            application,
            role: initial.role,
            ...(initial.subrole !== undefined ? { subrole: initial.subrole } : {}),
            contextFingerprint: topologyFingerprint,
          };
          let profileUpdated = false;
          if (key !== null) {
            const verifiedConstraints = {
              ...(minWidthFinding.kind === "exact" ? { minWidth: minWidthFinding.value } : {}),
              ...(minHeightFinding.kind === "exact" ? { minHeight: minHeightFinding.value } : {}),
              ...(maxWidth.kind === "exact" ? { maxWidth: maxWidth.value } : {}),
              ...(maxHeight.kind === "exact" ? { maxHeight: maxHeight.value } : {}),
            };
            if (Object.keys(verifiedConstraints).length > 0) {
              const previousLearning = learning;
              const previousPersistedLearning = persistedLearning;
              const previousObservationRevision = observationRevision;
              const previousObservationStoreFailed = observationStoreFailed;
              const previousDirty = learningDirty;
              setLearning(setVerifiedConstraints(learning, key, verifiedConstraints));
              const persisted = yield* Effect.either(persistLearning());
              if (persisted._tag === "Left") {
                learning = previousLearning;
                persistedLearning = previousPersistedLearning;
                observationRevision = previousObservationRevision;
                observationStoreFailed = previousObservationStoreFailed;
                learningDirty = previousDirty;
                syncProfiles();
                return yield* Effect.fail(new CommandError({
                  code: "internal_error",
                  message: `observation persistence failed: ${persisted.left.message}`,
                }));
              }
              profileUpdated = true;
            }
          }
          return {
            type: "windowLimitsProbe" as const,
            windowId,
            identity,
            target: {
              mode: "parked" as const,
              hostDisplayId: parked.display.id,
              corner: parked.corner,
              retainedVisibility: parked.visibility,
              positionCorrection: positionDiagnostics.some((entry) => entry.correction === "clamped") ? "clamped" as const : "verified" as const,
            },
            phases: {
              capability: "verified",
              parking: "adoptedVerified",
              minimumSize: "verified",
              maximumSize: "verified",
              restore: "verifiedExact",
            } as const,
            capability: { source: "parkedBehavioralProbe", movable: "supported", resizable: "supported" } as const,
            positionDiagnostics,
            originalFrame,
            restoredFrame,
            restoreStatus: "verifiedExact" as const,
            testedRanges: {
              width: { min: 1, max: maxTestWidth },
              height: { min: 1, max: maxTestHeight },
            },
            findings: {
              minWidth: minWidthFinding,
              minHeight: minHeightFinding,
              maxWidth,
              maxHeight,
            },
            profileUpdated,
          };
          }), () => restorationPending
            ? Effect.uninterruptible(restore()).pipe(Effect.ignore)
            : Effect.void);
        }),
      );

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
            const connectedDisplay = (id: DisplayId | null): DisplayId | null =>
              id !== null && world.topology.displays.some((display) => display.id === id) ? id : null;
            const desiredDisplayPre = existingNext
              ? (connectedDisplay(existingNext.visibleOnDisplay) ??
                connectedDisplay(existingNext.pinnedDisplayOverride) ??
                connectedDisplay(existingNext.preferredDisplay) ??
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
            const desiredDisplayIn = (draft: World): DisplayId | null => {
              const nextWs = draft.workspaces.get(command.name);
              const connected = (id: DisplayId | null): DisplayId | null =>
                id !== null && draft.topology.displays.some((display) => display.id === id) ? id : null;
              return nextWs
                ? (connected(nextWs.visibleOnDisplay) ??
                    connected(nextWs.pinnedDisplayOverride) ??
                    connected(nextWs.preferredDisplay) ??
                    primaryDisplayIn(draft)?.id ??
                    null)
                : (primaryDisplayIn(draft)?.id ?? null);
            };
            yield* executeCompound(
              affected,
              ({ intents, buffer }) => (w0) => {
                let w = ensureWorkspaceIn(w0, command.name);
                const desiredDisplay = desiredDisplayIn(w);
                w = { ...w, focusedWorkspace: command.name };
                buffer.push({ topic: "focus", payload: { workspace: command.name } });
                if (desiredDisplay !== null) {
                  w = revealIn(w, intents, command.name, desiredDisplay);
                }
                return w;
              },
              (draft) =>
                desiredDisplayIn(draft) === desiredDisplayPre
                  ? null
                  : new CommandError({
                      code: "topology_unstable",
                      message: "focus workspace destination changed during capture",
                    }),
              (draft) => {
                const workspace = draft.workspaces.get(command.name);
                if (workspace === undefined) return null;
                const members = [...tiledMembers(workspace.tree), ...workspace.floating].filter(
                  (id) => id !== EMPTY_TREE_LEAF && draft.windows.has(id),
                );
                return workspace.lastFocusedMember !== null && members.includes(workspace.lastFocusedMember)
                  ? workspace.lastFocusedMember
                  : (members[0] ?? null);
              },
            );
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
            yield* executeCompound(
              affected,
              ({ intents }) => (w0) => {
                let w = ensureWorkspaceIn(w0, command.workspace);
                w = {
                  ...w,
                  workspaces: new Map(w.workspaces).set(command.workspace, {
                    ...(w.workspaces.get(command.workspace)!),
                    pinnedDisplayOverride: command.displayId,
                  }),
                };
                return revealIn(w, intents, command.workspace, command.displayId);
              },
              (draft) =>
                draft.topology.displays.some((display) => display.id === command.displayId)
                  ? null
                  : new CommandError({
                      code: "topology_unstable",
                      message: `destination display ${command.displayId} disappeared during capture`,
                    }),
            );
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
            const outcome = yield* runExclusive(
              Effect.gen(function* () {
                const written = yield* Effect.either(writeFrame(command.windowId, target));
                yield* persistLearningBestEffort();
                return written;
              }),
            );
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
      probeWindowLimits,
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
            if (parsed.ok) {
              const prepared = configSource.prepare === undefined
                ? Either.right(undefined)
                : yield* Effect.either(configSource.prepare(parsed.config, "full"));
              if (prepared._tag === "Right") {
                config = parsed.config;
                syncConfiguredWorkspaces();
              } else {
                setHealth("degraded", "config_invalid");
                bus.publish("config", { status: "invalid", issues: prepared.left.issues.slice(0, 4) });
              }
            }
            else setHealth("degraded", "config_invalid");
          } else {
            setHealth("degraded", "config_unavailable");
          }

          if (observationStore !== undefined) {
            fibers.push(
              yield* Stream.runForEach(
                observationStore.changes(observationRevision),
                (snapshot) => Effect.gen(function* () {
                  const installed = yield* Effect.either(
                    runExclusive(installObservationSnapshot(snapshot)),
                  );
                  if (installed._tag === "Left") {
                    setHealth("degraded", `observation_store_${installed.left.code}`);
                    return;
                  }
                  if (installed.right) yield* gatedReconcile();
                }),
              ).pipe(
                Effect.catchAll((error) => Effect.sync(() => {
                  setHealth("degraded", `observation_store_${error.code}`);
                })),
                Effect.forkDaemon,
              ),
            );
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
                const next = applyConfigDelta(config, candidate.right);
                if (configSource.prepare !== undefined) {
                  const prepared = yield* Effect.either(configSource.prepare(next, "delta"));
                  if (prepared._tag === "Left") {
                    setHealth("degraded", "config_invalid");
                    bus.publish("config", {
                      status: "invalid",
                      issues: prepared.left.issues.slice(0, 4),
                    });
                    return;
                  }
                }
                config = next;
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
