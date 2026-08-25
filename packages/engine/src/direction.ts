import { Schema } from "effect";

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
