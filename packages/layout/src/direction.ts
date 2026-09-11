import { Schema } from "effect";
import type { Frame } from "./schema.js";

// Directional neighbor resolution — pure geometry/ranking shared by the
// focusDirection and moveDirection commands (bean wm-pmys). No platform or
// world concepts live here: callers supply observed frame centers and a
// stable candidate order.

export const Direction = Schema.Literal("left", "right", "up", "down");
export type Direction = typeof Direction.Type;

/** Observed frame center of the reference window. */
export interface DirectedOrigin {
  readonly x: number;
  readonly y: number;
}

/** One candidate window: stable id plus its observed frame center. */
export interface DirectionalCandidate {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface DirectionalNeighborInput {
  direction: Direction;
  origin: DirectedOrigin;
  /**
   * Candidates in STABLE order (tiled traversal then floating insertion
   * order). The origin itself must already be excluded. Negative
   * coordinates are fine — only differences are used.
   */
  candidates: readonly DirectionalCandidate[];
}

export interface DirectionalFocusCandidate {
  readonly id: string;
  readonly frame: Frame;
}

export interface DirectionalFocusNeighborInput {
  readonly direction: Direction;
  readonly origin: Frame;
  readonly candidates: readonly DirectionalFocusCandidate[];
}

const primaryAxisOf = (direction: Direction): "x" | "y" =>
  direction === "left" || direction === "right" ? "x" : "y";

const halfPlaneSign = (direction: Direction): 1 | -1 =>
  direction === "right" || direction === "down" ? 1 : -1;

/**
 * Deterministic directional neighbor among candidates:
 *
 * 1. Only candidates STRICTLY inside the requested half-plane qualify
 *    (e.g. `left` ⇒ candidate.x < origin.x).
 * 2. Rank by primary-axis gap ascending, then orthogonal-center distance
 *    ascending, then stable input order.
 * 3. At an edge (no forward candidate) wrap within the workspace: choose the
 *    candidate FARTHEST along the opposite primary edge (largest primary gap),
 *    then closest orthogonally, then stable order.
 *
 * Returns null when there is no candidate at all (single-window workspace).
 */
export function directionalNeighbor(input: DirectionalNeighborInput): string | null {
  if (input.candidates.length === 0) return null;
  const axis = primaryAxisOf(input.direction);
  const sign = halfPlaneSign(input.direction);
  const orthoAxis = axis === "x" ? "y" : "x";

  const ranked = input.candidates.map((candidate, index) => ({
    id: candidate.id,
    /** > 0 ⇔ strictly inside the requested half-plane. */
    delta: (candidate[axis] - input.origin[axis]) * sign,
    gap: Math.abs(candidate[axis] - input.origin[axis]),
    ortho: Math.abs(candidate[orthoAxis] - input.origin[orthoAxis]),
    index,
  }));

  const forward = ranked
    .filter((r) => r.delta > 0)
    .sort((a, b) => a.gap - b.gap || a.ortho - b.ortho || a.index - b.index);
  if (forward.length > 0) return forward[0]!.id;

  // Edge wrap: farthest on the opposite primary edge wins; ties break on
  // orthogonal distance and finally stable order.
  const wrapped = [...ranked].sort(
    (a, b) => b.gap - a.gap || a.ortho - b.ortho || a.index - b.index,
  );
  return wrapped[0]?.id ?? null;
}

const intervalGap = (aStart: number, aEnd: number, bStart: number, bEnd: number): number =>
  Math.max(0, aStart - bEnd, bStart - aEnd);

/** Selects the nearest window whose full frame is beyond the requested border. */
export function directionalFocusNeighbor(input: DirectionalFocusNeighborInput): string | null {
  const horizontal = input.direction === "left" || input.direction === "right";
  const originPrimaryStart = horizontal ? input.origin.x : input.origin.y;
  const originPrimaryEnd =
    originPrimaryStart + (horizontal ? input.origin.width : input.origin.height);
  const originOrthoStart = horizontal ? input.origin.y : input.origin.x;
  const originOrthoEnd = originOrthoStart + (horizontal ? input.origin.height : input.origin.width);

  const ranked = input.candidates.flatMap((candidate, index) => {
    const frame = candidate.frame;
    const candidatePrimaryStart = horizontal ? frame.x : frame.y;
    const candidatePrimaryEnd = candidatePrimaryStart + (horizontal ? frame.width : frame.height);
    const forward =
      input.direction === "left" || input.direction === "up"
        ? candidatePrimaryEnd <= originPrimaryStart
        : candidatePrimaryStart >= originPrimaryEnd;
    if (!forward) return [];

    const candidateOrthoStart = horizontal ? frame.y : frame.x;
    const candidateOrthoEnd = candidateOrthoStart + (horizontal ? frame.height : frame.width);
    return [
      {
        id: candidate.id,
        primaryGap:
          input.direction === "left" || input.direction === "up"
            ? originPrimaryStart - candidatePrimaryEnd
            : candidatePrimaryStart - originPrimaryEnd,
        orthoGap: intervalGap(
          originOrthoStart,
          originOrthoEnd,
          candidateOrthoStart,
          candidateOrthoEnd,
        ),
        orthoCenterGap: Math.abs(
          (originOrthoStart + originOrthoEnd) / 2 - (candidateOrthoStart + candidateOrthoEnd) / 2,
        ),
        index,
      },
    ];
  });

  ranked.sort(
    (a, b) =>
      a.primaryGap - b.primaryGap ||
      a.orthoGap - b.orthoGap ||
      a.orthoCenterGap - b.orthoCenterGap ||
      a.index - b.index,
  );
  return ranked[0]?.id ?? null;
}
