import { Effect } from "effect";
import type { Clock, PlatformAdapter } from "./platform.ts";
import type {
  DisplayId,
  DisplayObservation,
  Frame,
  Size,
  WindowId,
  WindowObservation,
} from "./schema.ts";
import type { ParkingCorner, ParkingFact, ParkingVisibility } from "./world.ts";
import {
  PARKING_ACCEPTANCE_PT,
  PARKING_TYPICAL_VISIBILITY,
  RESTORE_MATCH_THRESHOLD,
} from "./constants.ts";
import { fingerprint } from "./learn.ts";

/** Rejection threshold: half the integer probe step (see probeVisibility). */
const PARKING_REJECTION_PT = 0.5;
/** Binary-search termination resolution (finer than the ambiguity band). */
const SEARCH_RESOLUTION_PT = 0.25;

// Offscreen parking — docs/rewrite/engine-guide.md §Parking.
// macOS refuses fully-offscreen windows: park at a display corner leaving a
// measured sliver visible (~1 pt horizontal, ~52 pt vertical, probed).

export const CORNER_PRIORITY: readonly ParkingCorner[] = [
  "bottomLeft",
  "bottomRight",
  "topLeft",
  "topRight",
];

export const defaultParkingVisibility = (): ParkingVisibility => ({
  horizontal: PARKING_TYPICAL_VISIBILITY.horizontal,
  vertical: PARKING_TYPICAL_VISIBILITY.vertical,
});

const isLeft = (corner: ParkingCorner): boolean =>
  corner === "bottomLeft" || corner === "topLeft";
const isBottom = (corner: ParkingCorner): boolean =>
  corner === "bottomLeft" || corner === "bottomRight";

/**
 * Corner target math (works for negative-coordinate displays too):
 * left corners x = display.x − width + limits.horizontal;
 * right corners x = display.maxX − limits.horizontal;
 * top corners y = display.y − height + limits.vertical;
 * bottom corners y = display.maxY − limits.vertical.
 */
export function cornerTarget(
  display: DisplayObservation,
  corner: ParkingCorner,
  size: Size,
  visibility: ParkingVisibility,
): Frame {
  const displayMaxX = display.frame.x + display.frame.width;
  const displayMaxY = display.frame.y + display.frame.height;
  return {
    x: isLeft(corner)
      ? display.frame.x - size.width + visibility.horizontal
      : displayMaxX - visibility.horizontal,
    y: isBottom(corner)
      ? displayMaxY - visibility.vertical
      : display.frame.y - size.height + visibility.vertical,
    width: size.width,
    height: size.height,
  };
}

/** Zero-area intersection test vs other displays; edge-touch allowed. */
export function cornerFeasible(
  target: Frame,
  selfDisplayId: DisplayId,
  displays: readonly DisplayObservation[],
): boolean {
  for (const display of displays) {
    if (display.id === selfDisplayId) continue;
    if (positiveAreaOverlap(target, display.frame)) return false;
  }
  return true;
}

function positiveAreaOverlap(a: Frame, b: Frame): boolean {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0;
}

/** Feasible corners in priority order; a surrounded display has none. */
export function feasibleCorners(
  display: DisplayObservation,
  displays: readonly DisplayObservation[],
  size: Size,
  visibility: ParkingVisibility,
): ParkingCorner[] {
  return CORNER_PRIORITY.filter((corner) =>
    cornerFeasible(cornerTarget(display, corner, size, visibility), display.id, displays),
  );
}

// ---------------------------------------------------------------------------
// Facts — fingerprinted per display-local geometry (+OS version)
// ---------------------------------------------------------------------------

export function displayParkingFingerprint(
  display: DisplayObservation,
  osVersion?: string,
): string {
  const local = [
    display.id,
    display.scale,
    display.frame.x,
    display.frame.y,
    display.frame.width,
    display.frame.height,
    display.workArea.x,
    display.workArea.y,
    display.workArea.width,
    display.workArea.height,
    osVersion ?? "",
  ].join("|");
  return fingerprint(local);
}

export function findParkingFact(
  facts: readonly ParkingFact[],
  display: DisplayObservation,
  corner: ParkingCorner,
  osVersion?: string,
): ParkingFact | null {
  const fp = displayParkingFingerprint(display, osVersion);
  return (
    facts.find((f) => f.displayId === display.id && f.corner === corner && f.fingerprint === fp) ??
    null
  );
}

export function withParkingFact(facts: readonly ParkingFact[], fact: ParkingFact): ParkingFact[] {
  const without = facts.filter(
    (f) => !(f.displayId === fact.displayId && f.corner === fact.corner),
  );
  return [...without, fact];
}

// ---------------------------------------------------------------------------
// Probe candidate ordering — stale-probe starvation guard
// ---------------------------------------------------------------------------

export function intersectsAnyDisplay(
  window: WindowObservation,
  displays: readonly DisplayObservation[],
): boolean {
  return displays.some((d) => positiveAreaOverlap(window.frame, d.frame));
}

/**
 * Order probe candidates: an already-parked off-display window is a PREFERRED
 * seed; iteration continues through the remaining candidates on failure so we
 * never starve because the first candidate was already parked.
 */
export function orderProbeCandidates(
  candidates: readonly WindowObservation[],
  parkedIntentIds: ReadonlySet<WindowId>,
  displays: readonly DisplayObservation[],
): WindowObservation[] {
  const parkedSeeds: WindowObservation[] = [];
  const offscreenOthers: WindowObservation[] = [];
  const onscreen: WindowObservation[] = [];
  for (const candidate of candidates) {
    if (candidate.minimized || candidate.hidden) continue;
    const offDisplay = !intersectsAnyDisplay(candidate, displays);
    if (parkedIntentIds.has(candidate.id) && offDisplay) parkedSeeds.push(candidate);
    else if (offDisplay) offscreenOthers.push(candidate);
    else onscreen.push(candidate);
  }
  // Never starve on a single already-parked seed: rotate it after itself.
  return [...parkedSeeds.slice(1), ...offscreenOthers, ...onscreen, ...parkedSeeds.slice(0, 1)];
}

// ---------------------------------------------------------------------------
// Clamp discovery probe
// ---------------------------------------------------------------------------

export interface ParkingProbeDeps {
  adapter: PlatformAdapter;
  clock: Clock;
}

export interface ClampDiscoverySuccess {
  visibility: ParkingVisibility;
  probesUsed: number;
}

export type ClampDiscoveryFailure =
  | { kind: "no_candidates" }
  | { kind: "probe_failed"; detail: string }
  | { kind: "verification_failed"; detail: string };

/** Search budget per boundary: 2·(⌈log2(maxDistance)⌉+3)+2 probes. */
export function searchBudget(maxDistance: number): number {
  const log2 = Math.ceil(Math.log2(Math.max(2, maxDistance)));
  return 2 * (log2 + 3) + 2;
}

/**
 * Fractional clamps round toward the visible side (ceil for left/top limits
 * where larger = more visible; floor for right/bottom where smaller = more).
 */
export function roundLimitTowardVisible(
  corner: ParkingCorner,
  rawLimit: number,
  axis: "horizontal" | "vertical",
): number {
  const moreVisibleIsLarger =
    (axis === "horizontal" && isLeft(corner)) || (axis === "vertical" && !isBottom(corner));
  return moreVisibleIsLarger ? Math.ceil(rawLimit) : Math.floor(rawLimit);
}

interface AxisSearchState {
  accepted: number; // known-accepted visibility (from endpoint clamp)
  rejected: number; // known-rejected visibility (starts at 0)
}

const readWindowSafe = (
  deps: ParkingProbeDeps,
  id: WindowId,
): Effect.Effect<WindowObservation, ClampDiscoveryFailure> =>
  Effect.mapError(
    Effect.flatMap(deps.adapter.getWindow(id), (w) =>
      w === null ? Effect.fail("null") : Effect.succeed(w),
    ),
    (): ClampDiscoveryFailure => ({ kind: "probe_failed", detail: "window readback failed" }),
  );

const writePositionSafe = (
  deps: ParkingProbeDeps,
  id: WindowId,
  point: { x: number; y: number },
): Effect.Effect<Frame, ClampDiscoveryFailure> =>
  Effect.mapError(
    Effect.map(deps.adapter.setWindowPosition(id, point), (o) => o.observed),
    (): ClampDiscoveryFailure => ({ kind: "probe_failed", detail: "position write failed" }),
  );

/**
 * Probe one candidate visibility along `axis`, holding the orthogonal
 * coordinate FIXED at its accepted value (expressed as that axis's accepted
 * visibility). Orthogonal movement during the search is rejection evidence
 * (bean wm-ysdj), never inconclusive.
 */
const probeVisibility = (
  deps: ParkingProbeDeps,
  seedId: WindowId,
  seedFrame: Frame,
  display: DisplayObservation,
  corner: ParkingCorner,
  size: Size,
  axis: "horizontal" | "vertical",
  limit: number,
  heldAccepted: number,
  probesUsed: { count: number },
): Effect.Effect<"accepted" | "rejected", never> =>
  Effect.gen(function* () {
    probesUsed.count += 1;
    const visibility: ParkingVisibility =
      axis === "horizontal"
        ? { horizontal: limit, vertical: heldAccepted }
        : { horizontal: heldAccepted, vertical: limit };
    const target = cornerTarget(display, corner, size, visibility);
    const observed = yield* Effect.either(
      writePositionSafe(deps, seedId, { x: target.x, y: target.y }),
    );
    if (observed._tag === "Left") return "rejected";
    const frame = observed.right;

    // Sub-point rejection threshold: a full-point tolerance reads the adjacent
    // clamp as acceptance (Swift finding #3 / bean wm-ysdj). Half-step keeps
    // integer-step boundary samples decisively classified.
    const searchedClamped =
      axis === "horizontal"
        ? Math.abs(frame.x - target.x) > PARKING_REJECTION_PT
        : Math.abs(frame.y - target.y) > PARKING_REJECTION_PT;
    if (searchedClamped) return "rejected";

    // Orthogonal movement while probing this axis ⇒ rejection evidence.
    const orthoMoved =
      axis === "horizontal"
        ? Math.abs(frame.y - seedFrame.y) > PARKING_REJECTION_PT
        : Math.abs(frame.x - seedFrame.x) > PARKING_REJECTION_PT;
    return orthoMoved ? "rejected" : "accepted";
  });

const searchAxisLimit = (
  deps: ParkingProbeDeps,
  seedId: WindowId,
  seedFrame: Frame,
  display: DisplayObservation,
  corner: ParkingCorner,
  size: Size,
  axis: "horizontal" | "vertical",
  state: AxisSearchState,
  heldOrthogonal: number,
  budget: number,
  probesUsed: { count: number },
): Effect.Effect<number, never> =>
  Effect.gen(function* () {
    const maxDistance = Math.max(2, Math.max(display.frame.width, display.frame.height));
    const cap = probesUsed.count + Math.min(budget, searchBudget(maxDistance));

    let lo = state.rejected; // known-rejected visibility (fully-offscreen side)
    let hi = state.accepted; // known-accepted visibility (sliver side)
    while (probesUsed.count < cap && hi - lo > SEARCH_RESOLUTION_PT) {
      const mid = (lo + hi) / 2;
      const result = yield* probeVisibility(
        deps,
        seedId,
        seedFrame,
        display,
        corner,
        size,
        axis,
        mid,
        heldOrthogonal,
        probesUsed,
      );
      if (result === "accepted") hi = mid;
      else lo = mid;
    }
    return hi;
  });

const restoreSeed = (
  deps: ParkingProbeDeps,
  seedId: WindowId,
  originalPoint: { x: number; y: number },
  workAreaCenter: { x: number; y: number },
): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    // Fallback chain per engine-guide §Parking 4: original → work-area center → original.
    const attempts: Array<{ x: number; y: number }> = [
      originalPoint,
      workAreaCenter,
      originalPoint,
    ];
    for (const target of attempts) {
      const written = yield* Effect.either(writePositionSafe(deps, seedId, target));
      if (written._tag === "Left") continue;
      const settled = yield* Effect.either(readWindowSafe(deps, seedId));
      if (settled._tag === "Left") continue;
      const f = settled.right.frame;
      const restored =
        Math.abs(f.x - target.x) <= RESTORE_MATCH_THRESHOLD &&
        Math.abs(f.y - target.y) <= RESTORE_MATCH_THRESHOLD;
      if (restored) return true;
    }
    return false;
  });

/**
 * Discover the measured visibility limits for ONE display+corner using the
 * given ordered candidates. The final combined point is verified jointly once.
 * Seed windows are restored afterwards (fallback: work-area center anchor).
 */
export function discoverParkingLimits(
  deps: ParkingProbeDeps,
  display: DisplayObservation,
  displays: readonly DisplayObservation[],
  corner: ParkingCorner,
  candidates: readonly WindowObservation[],
): Effect.Effect<ClampDiscoverySuccess | ClampDiscoveryFailure, never> {
  const ordered = orderProbeCandidates(candidates, new Set(), displays).filter(
    (c) => c.frame.width > 0 && c.frame.height > 0 && !c.minimized && !c.hidden,
  );

  const attemptSeed = (
    seedIndex: number,
  ): Effect.Effect<ClampDiscoverySuccess | ClampDiscoveryFailure, never> =>
    Effect.gen(function* () {
      if (seedIndex >= ordered.length) {
        return { kind: "no_candidates" } satisfies ClampDiscoveryFailure;
      }
      const probesUsed = { count: 0 };
      const seed = ordered[seedIndex]!;
      const originalFrame = seed.frame;
      const size = { width: originalFrame.width, height: originalFrame.height };

      // Endpoint request: fully offscreen at this corner.
      const endpoint = cornerTarget(display, corner, size, { horizontal: 0, vertical: 0 });
      const written = yield* Effect.either(
        writePositionSafe(deps, seed.id, { x: endpoint.x, y: endpoint.y }),
      );
      if (written._tag === "Left") return yield* attemptSeed(seedIndex + 1);
      const clamped = written.right;

      // Which axes clamped? Fractional clamps round toward the visible side.
      const xClamped = Math.abs(clamped.x - endpoint.x) > PARKING_ACCEPTANCE_PT;
      const yClamped = Math.abs(clamped.y - endpoint.y) > PARKING_ACCEPTANCE_PT;

      if (!xClamped && !yClamped) {
        // Fully offscreen accepted here: zero-visibility fact.
        const ok = yield* verifyJoint(deps, seed.id, display, corner, size, {
          horizontal: 0,
          vertical: 0,
        });
        if (!ok) return yield* attemptSeed(seedIndex + 1);
        yield* restoreSeed(deps, seed.id, originalFrame, centerOf(display));
        return { visibility: { horizontal: 0, vertical: 0 }, probesUsed: probesUsed.count };
      }

      // Accepted visibilities implied by the endpoint clamp (pre-refinement).
      const clampImplied = {
        horizontal: roundLimitTowardVisible(
          corner,
          axisLimitFrom(clamped, size, display, corner, "horizontal"),
          "horizontal",
        ),
        vertical: roundLimitTowardVisible(
          corner,
          axisLimitFrom(clamped, size, display, corner, "vertical"),
          "vertical",
        ),
      };
      const seedImplied = {
        horizontal: Math.max(
          0,
          roundLimitTowardVisible(
            corner,
            axisLimitFrom(originalFrame, size, display, corner, "horizontal"),
            "horizontal",
          ),
        ),
        vertical: Math.max(
          0,
          roundLimitTowardVisible(
            corner,
            axisLimitFrom(originalFrame, size, display, corner, "vertical"),
            "vertical",
          ),
        ),
      };

      const budget = searchBudget(Math.max(display.frame.width, display.frame.height));
      const halfBudget = Math.max(2, Math.floor(budget / (xClamped && yClamped ? 2 : 1)));

      // Basis escalation: a corrupted endpoint observation (orthogonal drift
      // during refusal — bean wm-ysdj) poisons clamp-implied seeds. Retry the
      // same candidate with progressively more conservative bases.
      const attemptWithBasis = (
        basis: ParkingVisibility,
      ): Effect.Effect<ClampDiscoverySuccess | null, never> =>
        Effect.gen(function* () {
          // Refine the clamped axis ONLY, holding the orthogonal coordinate at
          // its accepted value (expressed as that axis's accepted visibility).
          const horizontal = xClamped
            ? roundLimitTowardVisible(
                corner,
                yield* searchAxisLimit(
                  deps,
                  seed.id,
                  originalFrame,
                  display,
                  corner,
                  size,
                  "horizontal",
                  { accepted: basis.horizontal, rejected: 0 },
                  basis.vertical,
                  halfBudget,
                  probesUsed,
                ),
                "horizontal",
              )
            : basis.horizontal;

          const vertical = yClamped
            ? roundLimitTowardVisible(
                corner,
                yield* searchAxisLimit(
                  deps,
                  seed.id,
                  // Hold horizontal at the refined visibility via the frame's x.
                  {
                    ...originalFrame,
                    x: cornerTarget(display, corner, size, {
                      horizontal,
                      vertical: basis.vertical,
                    }).x,
                  },
                  display,
                  corner,
                  size,
                  "vertical",
                  { accepted: basis.vertical, rejected: 0 },
                  horizontal,
                  halfBudget,
                  probesUsed,
                ),
                "vertical",
              )
            : basis.vertical;

          const visibility = yield* verifyWithNudge(
            deps,
            seed.id,
            display,
            corner,
            size,
            { horizontal, vertical },
            probesUsed,
          );
          return visibility === null ? null : { visibility, probesUsed: probesUsed.count };
        });

      let discovered: ClampDiscoverySuccess | null = null;
      for (const basis of [clampImplied, seedImplied, { ...PARKING_TYPICAL_VISIBILITY }]) {
        discovered = yield* attemptWithBasis(basis);
        if (discovered !== null) break;
      }
      if (discovered === null) {
        return yield* attemptSeed(seedIndex + 1);
      }

      yield* restoreSeed(deps, seed.id, originalFrame, centerOf(display));
      return { visibility: discovered.visibility, probesUsed: probesUsed.count };
    });

  return attemptSeed(0);
}

/**
 * Verify the rounded candidate; unachievable roundings (sub-point search
 * residue) nudge one point at a time toward the visible side, bounded.
 */
const verifyWithNudge = (
  deps: ParkingProbeDeps,
  seedId: WindowId,
  display: DisplayObservation,
  corner: ParkingCorner,
  size: Size,
  start: ParkingVisibility,
  probesUsed: { count: number },
): Effect.Effect<ParkingVisibility | null, never> =>
  Effect.gen(function* () {
    let candidate: ParkingVisibility | null = null;
    // Minimal-total-nudge order: never overshoots a granted boundary by more
    // than the rounded candidate already did.
    outer: for (let total = 0; total <= 4; total++) {
      for (let dh = 0; dh <= total; dh++) {
        const dv = total - dh;
        // Limits are "points kept visible" — more visible is always larger.
        const attempt: ParkingVisibility = {
          horizontal: start.horizontal + dh,
          vertical: start.vertical + dv,
        };
        const ok = yield* verifyJoint(deps, seedId, display, corner, size, attempt, 1e-6);
        if (ok) {
          candidate = attempt;
          break outer;
        }
      }
    }
    return candidate;
  });

/**
 * Limit implied by the endpoint's clamped observation, before refinement:
 * left/top: observed sliver beyond the display edge; right/bottom mirrored.
 */
function axisLimitFrom(
  clamped: Frame,
  size: Size,
  display: DisplayObservation,
  corner: ParkingCorner,
  axis: "horizontal" | "vertical",
): number {
  if (axis === "horizontal") {
    return isLeft(corner)
      ? clamped.x + size.width - display.frame.x
      : display.frame.x + display.frame.width - clamped.x;
  }
  return isBottom(corner)
    ? display.frame.y + display.frame.height - clamped.y
    : clamped.y + size.height - display.frame.y;
}

const centerOf = (display: DisplayObservation): { x: number; y: number } => ({
  x: display.workArea.x + display.workArea.width / 2,
  y: display.workArea.y + display.workArea.height / 2,
});

/** One joint verification of the final combined point. */
function verifyJoint(
  deps: ParkingProbeDeps,
  seedId: WindowId,
  display: DisplayObservation,
  corner: ParkingCorner,
  size: Size,
  visibility: ParkingVisibility,
  tolerance: number = PARKING_ACCEPTANCE_PT,
): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    const target = cornerTarget(display, corner, size, visibility);
    const written = yield* Effect.either(
      writePositionSafe(deps, seedId, { x: target.x, y: target.y }),
    );
    if (written._tag === "Left") return false;
    const settled = yield* readWindowSafe(deps, seedId).pipe(Effect.either);
    if (settled._tag === "Left") return false;
    const f = settled.right.frame;
    return Math.abs(f.x - target.x) <= tolerance && Math.abs(f.y - target.y) <= tolerance;
  });
}
