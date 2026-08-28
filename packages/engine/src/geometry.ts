import type { Constraints, Frame, GeometryOutcome, Point } from "./schema.ts";
import { CONTAINMENT_TOLERANCE_PT, RETRY_LADDER, type WriteStrategy } from "./constants.ts";

export const isFiniteNumber = (n: number): boolean => Number.isFinite(n);

export const isFiniteFrame = (f: Frame): boolean =>
  isFiniteNumber(f.x) && isFiniteNumber(f.y) && isFiniteNumber(f.width) && isFiniteNumber(f.height);

export const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/** Half-open containment: [x, x+width) × [y, y+height). */
export function containsPoint(frame: Frame, point: Point): boolean {
  return (
    point.x >= frame.x &&
    point.x < frame.x + frame.width &&
    point.y >= frame.y &&
    point.y < frame.y + frame.height
  );
}

/** Positive-area intersection; edge-touching frames do NOT intersect. */
export function intersects(a: Frame, b: Frame): boolean {
  return (
    Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 0 &&
    Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 0
  );
}

export function intersectionArea(a: Frame, b: Frame): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export const center = (frame: Frame): Point => ({
  x: frame.x + frame.width / 2,
  y: frame.y + frame.height / 2,
});

export function frameMaxX(frame: Frame): number {
  return frame.x + frame.width;
}

export function frameMaxY(frame: Frame): number {
  return frame.y + frame.height;
}

/**
 * Shift `frame` minimally until fully inside `bounds`. Frames larger than the
 * bounds align their top-left corner with the bounds origin.
 */
export function clampFrameToBounds(frame: Frame, bounds: Frame): Frame {
  const maxX = Math.max(bounds.x, bounds.x + bounds.width - frame.width);
  const maxY = Math.max(bounds.y, bounds.y + bounds.height - frame.height);
  return {
    x: clampNumber(frame.x, bounds.x, maxX),
    y: clampNumber(frame.y, bounds.y, maxY),
    width: frame.width,
    height: frame.height,
  };
}

export type FrameComponent = "x" | "y" | "width" | "height";

const componentDelta = (a: Frame, b: Frame, c: FrameComponent): number => Math.abs(a[c] - b[c]);

export function withinTolerance(a: Frame, b: Frame, tolerance: number): boolean {
  return (
    componentDelta(a, b, "x") <= tolerance &&
    componentDelta(a, b, "y") <= tolerance &&
    componentDelta(a, b, "width") <= tolerance &&
    componentDelta(a, b, "height") <= tolerance
  );
}

export const positionWithinTolerance = (a: Frame, b: Frame, tolerance: number): boolean =>
  componentDelta(a, b, "x") <= tolerance && componentDelta(a, b, "y") <= tolerance;

export const sizeWithinTolerance = (a: Frame, b: Frame, tolerance: number): boolean =>
  componentDelta(a, b, "width") <= tolerance && componentDelta(a, b, "height") <= tolerance;

/**
 * Normalized distance between frames: component deltas scaled by frame
 * magnitude so position and size errors are comparable across window sizes.
 */
export function normalizedDistance(a: Frame, b: Frame): number {
  const scale = Math.max(1, (a.width + a.height + b.width + b.height) / 4);
  return (
    (componentDelta(a, b, "x") +
      componentDelta(a, b, "y") +
      componentDelta(a, b, "width") +
      componentDelta(a, b, "height")) /
    scale
  );
}

// ---------------------------------------------------------------------------
// Outcome classification — docs/rewrite/domain-schema.md §Outcome classification
// ---------------------------------------------------------------------------

export interface ClassifyInput {
  requested: Frame;
  observed: Frame;
  tolerance: number;
  /** Stable flag from the adapter's settle polling. */
  stable: boolean;
  /** Known learned constraints used for the `constrained` verdict. */
  constraints?: Constraints | undefined;
  /** Untouched frame at operation start; guards the stableClamp verdict. */
  initialFrame?: Frame | undefined;
  /** Previous readback; enables the `progressing` verdict. */
  previousObserved?: Frame | undefined;
  /** Parking-only acceptance for a stable OS clamp that preserves exact size. */
  acceptStablePositionClamp?: boolean | undefined;
}

function constrainedMatch(
  requested: Frame,
  observed: Frame,
  tolerance: number,
  constraints: Constraints,
): boolean {
  let clampedAny = false;

  const checkAxis = (
    reqValue: number,
    obsValue: number,
    min: number | undefined,
    max: number | undefined,
  ): boolean => {
    if (min !== undefined && reqValue < min) {
      if (Math.abs(obsValue - min) <= tolerance) {
        clampedAny = true;
        return true;
      }
      return false;
    }
    if (max !== undefined && reqValue > max) {
      if (Math.abs(obsValue - max) <= tolerance) {
        clampedAny = true;
        return true;
      }
      return false;
    }
    return Math.abs(obsValue - reqValue) <= tolerance;
  };

  const axesOk =
    checkAxis(requested.width, observed.width, constraints.minWidth, constraints.maxWidth) &&
    checkAxis(requested.height, observed.height, constraints.minHeight, constraints.maxHeight);

  return axesOk && clampedAny && positionWithinTolerance(requested, observed, tolerance);
}

export function classifyWrite(input: ClassifyInput): GeometryOutcome {
  const { requested, observed, tolerance, stable } = input;
  if (withinTolerance(requested, observed, tolerance)) return "exact";

  if (
    input.constraints !== undefined &&
    constrainedMatch(requested, observed, tolerance, input.constraints)
  ) {
    return "constrained";
  }

  if (
    input.acceptStablePositionClamp === true &&
    stable &&
    Math.abs(observed.width - requested.width) <= tolerance &&
    Math.abs(observed.height - requested.height) <= tolerance &&
    !positionWithinTolerance(requested, observed, tolerance)
  ) {
    return "stableClamp";
  }

  if (
    input.previousObserved !== undefined &&
    normalizedDistance(observed, requested) < normalizedDistance(input.previousObserved, requested)
  ) {
    return "progressing";
  }

  if (
    stable &&
    !withinTolerance(requested, observed, tolerance) &&
    positionWithinTolerance(requested, observed, tolerance)
  ) {
    const initial = input.initialFrame ?? requested;
    const sizeDiffersFromBoth =
      (Math.abs(observed.width - requested.width) > tolerance &&
        Math.abs(observed.width - initial.width) > tolerance) ||
      (Math.abs(observed.height - requested.height) > tolerance &&
        Math.abs(observed.height - initial.height) > tolerance);
    if (sizeDiffersFromBoth) return "stableClamp";
  }

  return "failed";
}

// ---------------------------------------------------------------------------
// Retry ladder — docs/rewrite/domain-schema.md §Numeric constants
// ---------------------------------------------------------------------------

export const LADDER_LENGTH = RETRY_LADDER.length;

export function strategyAt(index: number): WriteStrategy {
  const clamped = RETRY_LADDER[clampNumber(index, 0, LADDER_LENGTH - 1)];
  return clamped ?? "positionSize";
}

/** Ladder start index for a window with the given corrective history. */
export function ladderStartIndex(correctiveAttemptCount: number | undefined): number {
  return correctiveAttemptCount !== undefined && correctiveAttemptCount > 1 ? 1 : 0;
}

/** Tiling acceptance: within content ±1 pt OR center inside content. */
export function satisfiesContainment(frame: Frame, content: Frame): boolean {
  if (withinTolerance(frame, content, CONTAINMENT_TOLERANCE_PT)) return true;
  return containsPoint(content, center(frame));
}

/** Inset a rect by per-edge margins (positive shrinks, negative extends). */
export function insetFrame(
  frame: Frame,
  margins:
    | {
        top?: number | undefined;
        right?: number | undefined;
        bottom?: number | undefined;
        left?: number | undefined;
      }
    | undefined,
): Frame {
  const left = margins?.left ?? 0;
  const top = margins?.top ?? 0;
  const right = margins?.right ?? 0;
  const bottom = margins?.bottom ?? 0;
  return {
    x: frame.x + left,
    y: frame.y + top,
    width: Math.max(0, frame.width - left - right),
    height: Math.max(0, frame.height - top - bottom),
  };
}
