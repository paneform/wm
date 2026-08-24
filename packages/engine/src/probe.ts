import { Effect } from "effect";
import type { PlatformAdapter, Clock } from "./platform.ts";
import type {
  Capabilities,
  Frame,
  WindowId,
  WindowObservation,
} from "./schema.ts";
import {
  PROBE_DELTA,
  PROBE_MATCH_THRESHOLD,
  RESTORE_MATCH_THRESHOLD,
  SETTLE_MAX_READS,
  SETTLE_POLL_DELAY_MS,
} from "./constants.ts";

// Capability probing — docs/rewrite/engine-guide.md §Probes.
// Primitive writes ±1 pt per dimension; identity is validated around EVERY
// write so a replacement window behind the same handle aborts before mutation.

export type ProbeDimension = "x-" | "x+" | "y-" | "y+" | "w-" | "w+" | "h-" | "h+";

export const POSITION_DIMENSIONS: readonly ProbeDimension[] = ["x-", "x+", "y-", "y+"];
export const SIZE_DIMENSIONS: readonly ProbeDimension[] = ["w-", "w+", "h-", "h+"];

type FrameComponent = "x" | "y" | "width" | "height";

export interface DimensionProbeOutcome {
  dimension: ProbeDimension;
  /** Write refused by the platform (or restore failed ⇒ treated as rejected). */
  rejected: boolean;
  changed: boolean;
  matchedRequest: boolean;
  crossChanged: boolean;
  supportsCapability: boolean;
}

export interface CapabilityProbeResult {
  movable: Capabilities["movable"];
  resizable: Capabilities["resizable"];
  evidenceSource: "behavioral_probe";
  dimensions: readonly DimensionProbeOutcome[];
  aborted: boolean;
  abortReason?: string | undefined;
}

export type ProbeError =
  | { kind: "stale"; detail?: string }
  | { kind: "platform"; detail?: string }
  | { kind: "not_found" };

/** Identity signature validated around every write (pid + role + subrole + bundle). */
export function identitySignature(observation: WindowObservation): string {
  return JSON.stringify([
    observation.pid,
    observation.role,
    observation.subrole ?? "",
    observation.bundleId ?? "",
  ]);
}

const readWindow = (
  adapter: PlatformAdapter,
  id: WindowId,
): Effect.Effect<WindowObservation, ProbeError> =>
  Effect.flatMap(
    Effect.mapError(adapter.getWindow(id), (e): ProbeError => ({ kind: "platform", detail: e.detail ?? "readback failed" })),
    (observed) =>
      observed === null
        ? Effect.fail<ProbeError>({ kind: "not_found" })
        : Effect.succeed(observed),
  );

const validateIdentity = (
  adapter: PlatformAdapter,
  id: WindowId,
  expected: string,
): Effect.Effect<WindowObservation, ProbeError> =>
  Effect.flatMap(readWindow(adapter, id), (observed) =>
    identitySignature(observed) === expected
      ? Effect.succeed(observed)
      : Effect.fail<ProbeError>({ kind: "stale", detail: "identity changed during probe" }),
  );

interface SettleResult {
  observation: WindowObservation;
}

/** Settle polling after a probe write: ≤ SETTLE_MAX_READS reads with delays. */
const settleRead = (
  adapter: PlatformAdapter,
  clock: Clock,
  id: WindowId,
): Effect.Effect<SettleResult, ProbeError> =>
  Effect.gen(function* () {
    let previous = yield* readWindow(adapter, id);
    for (let read = 1; read < SETTLE_MAX_READS; read++) {
      yield* clock.sleep(SETTLE_POLL_DELAY_MS);
      const next = yield* readWindow(adapter, id);
      const settled = framesWithinThreshold(previous.frame, next.frame);
      previous = next;
      if (settled) break;
    }
    return { observation: previous };
  });

const framesWithinThreshold = (a: Frame, b: Frame): boolean =>
  Math.abs(a.x - b.x) <= PROBE_MATCH_THRESHOLD &&
  Math.abs(a.y - b.y) <= PROBE_MATCH_THRESHOLD &&
  Math.abs(a.width - b.width) <= PROBE_MATCH_THRESHOLD &&
  Math.abs(a.height - b.height) <= PROBE_MATCH_THRESHOLD;

const isSizeDimension = (dimension: ProbeDimension): boolean =>
  dimension.startsWith("w") || dimension.startsWith("h");

const componentValue = (frame: Frame, dimension: ProbeDimension): number => {
  switch (touchedComponent(dimension)) {
    case "x":
      return frame.x;
    case "y":
      return frame.y;
    case "width":
      return frame.width;
    case "height":
      return frame.height;
  }
};

const touchedComponent = (dimension: ProbeDimension): FrameComponent => {
  switch (dimension[1]) {
    case "-":
    case "+": {
      switch (dimension[0]) {
        case "x":
          return "x";
        case "y":
          return "y";
        case "w":
          return "width";
        default:
          return "height";
      }
    }
    default:
      return "x";
  }
};

const writeComponent = (
  adapter: PlatformAdapter,
  id: WindowId,
  dimension: ProbeDimension,
  frame: Frame,
): Effect.Effect<void, ProbeError> => {
  if (isSizeDimension(dimension)) {
    return Effect.mapError(
      adapter.setWindowSize(id, { width: frame.width, height: frame.height }),
      () => ({ kind: "platform" as const }),
    );
  }
  return Effect.mapError(
    adapter.setWindowPosition(id, { x: frame.x, y: frame.y }),
    () => ({ kind: "platform" as const }),
  );
};

const rejectedOutcome = (dimension: ProbeDimension): DimensionProbeOutcome => ({
  dimension,
  rejected: true,
  changed: false,
  matchedRequest: false,
  crossChanged: false,
  supportsCapability: false,
});

const otherComponentsMoved = (
  before: Frame,
  after: Frame,
  dimension: ProbeDimension,
): boolean => {
  const touched = touchedComponent(dimension);
  const components: FrameComponent[] = ["x", "y", "width", "height"];
  return components.some(
    (c) => c !== touched && Math.abs(after[c] - before[c]) > PROBE_MATCH_THRESHOLD,
  );
};

/**
 * Restore a touched component to its original value and verify within
 * RESTORE_MATCH_THRESHOLD; retries the write while polling allows.
 */
const restoreComponent = (
  adapter: PlatformAdapter,
  clock: Clock,
  id: WindowId,
  dimension: ProbeDimension,
  originalFrame: Frame,
  identity: string,
): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < SETTLE_MAX_READS; attempt++) {
      const identityCheck = yield* Effect.either(validateIdentity(adapter, id, identity));
      if (identityCheck._tag === "Left") return false;
      const written = yield* Effect.either(
        writeComponent(adapter, id, dimension, originalFrame),
      );
      if (written._tag === "Left") return false;
      const settled = yield* Effect.either(settleRead(adapter, clock, id));
      if (settled._tag === "Left") return false;
      const observedValue = componentValue(settled.right.observation.frame, dimension);
      const originalValue = componentValue(originalFrame, dimension);
      if (Math.abs(observedValue - originalValue) <= RESTORE_MATCH_THRESHOLD) return true;
    }
    return false;
  });

type DimensionProbeStep =
  | { tag: "outcome"; outcome: DimensionProbeOutcome }
  | { tag: "abort"; reason: string };

/**
 * Nudge one dimension ±PROBE_DELTA and classify:
 * supported requires changed AND matchedRequest AND NOT crossChanged.
 */
const probeDimensionOnce = (
  adapter: PlatformAdapter,
  clock: Clock,
  id: WindowId,
  dimension: ProbeDimension,
  baseline: WindowObservation,
): Effect.Effect<DimensionProbeStep, never> => {
  const identity = identitySignature(baseline);
  const before = baseline.frame;
  const sign = dimension.endsWith("-") ? -1 : 1;
  // Probe delta floored at ≥1 pt per dimension.
  const targetValue = componentValue(before, dimension) + sign * Math.max(1, PROBE_DELTA);
  const touched = touchedComponent(dimension);
  const targetFrame: Frame =
    touched === "x"
      ? { ...before, x: targetValue }
      : touched === "y"
        ? { ...before, y: targetValue }
        : touched === "width"
          ? { ...before, width: targetValue }
          : { ...before, height: targetValue };

  return Effect.gen(function* () {
    // Identity validated immediately before every write.
    const pre = yield* Effect.either(validateIdentity(adapter, id, identity));
    if (pre._tag === "Left") {
      return { tag: "abort", reason: "identity changed before probe write" };
    }

    const written = yield* Effect.either(writeComponent(adapter, id, dimension, targetFrame));
    if (written._tag === "Left") {
      return { tag: "outcome", outcome: rejectedOutcome(dimension) };
    }

    const settled = yield* Effect.either(settleRead(adapter, clock, id));
    if (settled._tag === "Left") {
      return { tag: "abort", reason: "readback failed after probe write" };
    }
    const after = settled.right.observation.frame;

    // Identity validated again after the write — never mutate a replacement.
    const post = yield* Effect.either(validateIdentity(adapter, id, identity));
    if (post._tag === "Left") {
      return { tag: "abort", reason: "identity changed after probe write" };
    }

    const restored = yield* restoreComponent(adapter, clock, id, dimension, before, identity);
    if (!restored) {
      // Abort probing on restore failure.
      return { tag: "abort", reason: "restore verification failed" };
    }

    const changed =
      Math.abs(componentValue(after, dimension) - componentValue(before, dimension)) >
      PROBE_MATCH_THRESHOLD;
    const matchedRequest =
      Math.abs(componentValue(after, dimension) - targetValue) <= PROBE_MATCH_THRESHOLD;
    const crossChanged = otherComponentsMoved(before, after, dimension);

    return {
      tag: "outcome",
      outcome: {
        dimension,
        rejected: false,
        changed,
        matchedRequest,
        crossChanged,
        supportsCapability: changed && matchedRequest && !crossChanged,
      },
    } satisfies DimensionProbeStep;
  });
};

function finalizeFrom(outcomes: readonly DimensionProbeOutcome[]): CapabilityProbeResult {
  const sizeOutcomes = outcomes.filter((o) => isSizeDimension(o.dimension));
  const posOutcomes = outcomes.filter((o) => !isSizeDimension(o.dimension));

  const anySupported = (list: readonly DimensionProbeOutcome[]): boolean =>
    list.some((o) => o.supportsCapability);
  const allRejected = (list: readonly DimensionProbeOutcome[]): boolean =>
    list.length > 0 && list.every((o) => o.rejected);

  return {
    // All four size dims rejected ⇒ resizable fixed (confirmed). Position dims
    // without observable change stay inconclusive per testing-guide behavior 7.
    resizable: allRejected(sizeOutcomes)
      ? "fixed"
      : anySupported(sizeOutcomes)
        ? "supported"
        : "inconclusive",
    movable: anySupported(posOutcomes) ? "supported" : "inconclusive",
    evidenceSource: "behavioral_probe",
    dimensions: outcomes,
    aborted: false,
  };
}

/**
 * Run the full 8-direction capability probe. Identity failure or restore
 * failure aborts probing and returns a partial result with aborted=true.
 */
export function runCapabilityProbe(
  adapter: PlatformAdapter,
  clock: Clock,
  windowId: WindowId,
): Effect.Effect<CapabilityProbeResult, ProbeError> {
  const dimensions: ProbeDimension[] = [...POSITION_DIMENSIONS, ...SIZE_DIMENSIONS];

  return Effect.gen(function* () {
    const baseline = yield* readWindow(adapter, windowId);
    if (baseline.minimized || baseline.hidden) {
      return {
        movable: "inconclusive",
        resizable: "inconclusive",
        evidenceSource: "behavioral_probe" as const,
        dimensions: dimensions.map(rejectedOutcome),
        aborted: true,
        abortReason: "window minimized or hidden",
      };
    }

    const outcomes: DimensionProbeOutcome[] = [];
    let abortReason: string | undefined;

    for (const dimension of dimensions) {
      // Re-read baseline each iteration: earlier restores may shift geometry.
      const current = yield* Effect.either(
        validateIdentity(adapter, windowId, identitySignature(baseline)),
      );
      if (current._tag === "Left") {
        abortReason = "identity changed between probes";
        break;
      }
      const outcome = yield* probeDimensionOnce(adapter, clock, windowId, dimension, current.right);
      if (outcome.tag === "abort") {
        abortReason = outcome.reason;
        break;
      }
      outcomes.push(outcome.outcome);
    }

    if (abortReason !== undefined) {
      return {
        ...finalizeFrom(outcomes),
        aborted: true,
        abortReason,
      };
    }
    return finalizeFrom(outcomes);
  });
}
