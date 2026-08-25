import { Effect } from "effect";
import type { Clock, PlatformAdapter } from "./platform.ts";
import type {
  Constraints,
  Frame,
  GeometryOutcome,
  GeometryRequest,
  WindowId,
  WindowObservation,
} from "./schema.ts";
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_TOLERANCE,
  SETTLE_MAX_READS,
  SETTLE_POLL_DELAY_MS,
} from "./constants.ts";
import {
  classifyWrite,
  ladderStartIndex,
  normalizedDistance,
  strategyAt,
  withinTolerance,
} from "./geometry.ts";
import { candidatesFrom, type CandidateScan } from "./learn.ts";

// Geometry service — applies GeometryRequests through PlatformAdapter
// primitives with settle polling, classification, and retry-ladder escalation.
// Success is `exact | constrained` only; mid-animation budget exhaustion is
// reported honestly as `progressing`, never clobbered as failure.

export interface GeometryCallContext {
  /** Known + viable bounds used by the constrained classifier. */
  constraints: Constraints;
  /** Untouched frame at operation start (initial-frame guard). */
  initialFrame: Frame;
  /** Work area of the window's display (learning flush guard). */
  workArea: Frame;
  /** Profile-informed early skip when corrective fallbacks were needed before. */
  correctiveAttemptCount?: number | undefined;
}

export interface GeometrySuccess {
  outcome: "exact" | "constrained";
  frame: Frame;
  strategy: string;
  attemptsUsed: number;
  learning: CandidateScan;
}

export interface GeometryProgressing {
  outcome: "progressing";
  frame: Frame;
  strategy: string;
  attemptsUsed: number;
  learning: CandidateScan;
}

export type GeometryResult = GeometrySuccess | GeometryProgressing;

export interface GeometryFailure {
  code: "stale" | "rejected" | "unavailable" | "invalid";
  outcome: GeometryOutcome | "error";
  /** Last observed frame so callers can inspect/recover. */
  observed?: Frame | undefined;
  detail?: string | undefined;
}

const readWindow = (
  adapter: PlatformAdapter,
  id: WindowId,
): Effect.Effect<WindowObservation, GeometryFailure> =>
  Effect.mapError(
    adapter.getWindow(id),
    (error): GeometryFailure => ({
      code:
        error.code === "permission" || error.code === "unavailable"
          ? "unavailable"
          : error.code === "stale"
            ? "stale"
            : "rejected",
      outcome: "error",
      detail: error.detail ?? error.code,
    }),
  ).pipe(
    Effect.flatMap((observed) =>
      observed === null
        ? Effect.fail<GeometryFailure>({
            code: "stale",
            outcome: "error",
            detail: "window not found during geometry operation",
          })
        : Effect.succeed(observed),
    ),
  );

interface Readback {
  observation: WindowObservation;
  matchedTarget: boolean;
  distanceToTarget: number;
}

/** Settle polling: ≤11 reads via injected Clock.sleep, stop early on match. */
const settlePoll = (
  adapter: PlatformAdapter,
  clock: Clock,
  id: WindowId,
  target: Frame,
  tolerance: number,
): Effect.Effect<Readback, GeometryFailure> => {
  const distance = (frame: Frame): number => normalizedDistance(frame, target);
  return Effect.gen(function* () {
    let current = yield* readWindow(adapter, id);
    let best: Readback = {
      observation: current,
      matchedTarget: withinTolerance(current.frame, target, tolerance),
      distanceToTarget: distance(current.frame),
    };
    for (let read = 1; read < SETTLE_MAX_READS && !best.matchedTarget; read++) {
      yield* clock.sleep(SETTLE_POLL_DELAY_MS);
      current = yield* readWindow(adapter, id);
      const next: Readback = {
        observation: current,
        matchedTarget: withinTolerance(current.frame, target, tolerance),
        distanceToTarget: distance(current.frame),
      };
      if (next.distanceToTarget < best.distanceToTarget) best = next;
      if (best.matchedTarget) break;
    }
    return best;
  });
};

type StrategyPlan = Array<"position" | "size">;

function strategyWrites(strategy: string): StrategyPlan {
  switch (strategy) {
    case "positionSize":
      return ["position", "size"];
    case "sizeOnly":
      return ["size"];
    case "sizePositionSize":
      return ["size", "position", "size"];
    case "convergedSizePositionSize":
      // Double size bookend: many apps re-anchor their origin when resized.
      return ["size", "position", "size", "size"];
    default:
      return ["position", "size"];
  }
}

const identityOf = (observation: WindowObservation): string =>
  JSON.stringify([observation.pid, observation.role, observation.subrole ?? ""]);

const writeComponent = (
  adapter: PlatformAdapter,
  id: WindowId,
  part: "position" | "size",
  frame: Frame,
): Effect.Effect<Frame, GeometryFailure> => {
  const failMap = (error: { code?: string; detail?: string | undefined }): GeometryFailure => ({
    // Identity-replacement aborts must keep their `stale` semantics
    // (platform-contract §4) instead of flattening to a generic rejection.
    code: error.code === "stale" ? "stale" : "rejected",
    outcome: "error",
    detail: error.detail ?? "write refused",
  });
  if (part === "position") {
    return Effect.mapError(
      adapter.setWindowPosition(id, { x: frame.x, y: frame.y }),
      failMap,
    ).pipe(Effect.map((o) => o.observed));
  }
  return Effect.mapError(adapter.setWindowSize(id, { width: frame.width, height: frame.height }), failMap).pipe(
    Effect.map((o) => o.observed),
  );
};

/**
 * Apply one geometry request. Attempts walk the retry ladder starting at
 * `ladderStartIndex(correctiveAttemptCount)`; each attempt ends in settle
 * polling + classification. Learning candidates are extracted for the engine.
 */
export function applyGeometryRequest(
  deps: { adapter: PlatformAdapter; clock: Clock },
  request: GeometryRequest,
  context: GeometryCallContext,
): Effect.Effect<GeometryResult, GeometryFailure> {
  const tolerance = request.tolerance ?? DEFAULT_TOLERANCE;
  const attempts = request.attempts ?? DEFAULT_ATTEMPTS;
  const target = request.frame;

  const loop = (attemptIndex: number): Effect.Effect<GeometryResult, GeometryFailure> =>
    Effect.gen(function* () {
      if (attemptIndex >= attempts) {
        // Budget exhausted without success.
        const last = yield* readWindow(deps.adapter, request.windowId).pipe(Effect.either);
        return yield* Effect.fail<GeometryFailure>({
          code: "rejected",
          outcome: "failed",
          observed: last._tag === "Right" ? last.right.frame : undefined,
          detail: "geometry attempts exhausted",
        });
      }

      const strategy = strategyAt(
        ladderStartIndex(context.correctiveAttemptCount) + attemptIndex,
      );
      const baseline = yield* readWindow(deps.adapter, request.windowId);
      const identity = identityOf(baseline);

      let observedFrame = baseline.frame;
      for (const part of strategyWrites(strategy)) {
        const identityCheck = yield* Effect.either(readWindow(deps.adapter, request.windowId));
        if (
          identityCheck._tag === "Left" ||
          identityOf(identityCheck.right) !== identity
        ) {
          return yield* Effect.fail<GeometryFailure>({
            code: "stale",
            outcome: "error",
            observed: identityCheck._tag === "Right" ? identityCheck.right.frame : undefined,
            detail: "window identity changed mid-write",
          });
        }
        observedFrame = yield* writeComponent(deps.adapter, request.windowId, part, target);
      }

      const readback = yield* settlePoll(deps.adapter, deps.clock, request.windowId, target, tolerance);

      const outcome = classifyWrite({
        requested: target,
        observed: readback.observation.frame,
        tolerance,
        stable: true,
        constraints: context.constraints,
        initialFrame: context.initialFrame,
        previousObserved: baseline.frame,
      });

      const learning = candidatesFrom({
        outcome,
        requested: target,
        observed: readback.observation.frame,
        initial: context.initialFrame,
        workArea: context.workArea,
        tolerance,
      });

      if (outcome === "exact" || outcome === "constrained") {
        return {
          outcome,
          frame: readback.observation.frame,
          strategy,
          attemptsUsed: attemptIndex + 1,
          learning,
        } satisfies GeometryResult;
      }

      if (attemptIndex + 1 >= attempts) {
        if (outcome === "progressing") {
          // Report progressing honestly — never clobber a window animating
          // toward its target (engine-guide §Geometry transactions).
          return {
            outcome: "progressing",
            frame: readback.observation.frame,
            strategy,
            attemptsUsed: attemptIndex + 1,
            learning,
          } satisfies GeometryResult;
        }
        return yield* Effect.fail<GeometryFailure>({
          code: "rejected",
          outcome,
          observed: readback.observation.frame,
          detail: `geometry write ${outcome}`,
        });
      }

      return yield* loop(attemptIndex + 1);
    });

  return loop(0);
}
