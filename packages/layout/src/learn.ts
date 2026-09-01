import type { Constraints, EvidenceSource, Frame, TopologyObservation } from "./schema.js";
import type { Confidence, Profile, ProfileKey } from "./world.js";
import {
  LEARNED_CONFIDENCE_SAMPLES,
  PROMOTION_CONSISTENCY_PT,
  PROMOTION_SAMPLES,
  STRONG_CONFIDENCE_SAMPLES,
  VIABILITY_MARGIN_PT,
  WORK_AREA_FLUSH_GUARD_PT,
} from "./constants.js";
import type { GeometryOutcome } from "./schema.js";

// Evidence-gated constraint learning — docs/rewrite/engine-guide.md §Probes/Learning.
// Constraints are learned ONLY from `constrained`/`stableClamp` outcomes that
// pass the work-area flush guard and the initial-frame guard.

export type ConstraintAxis = "width" | "height";
export type BoundDirection = "min" | "max";

export interface ConstraintCandidate {
  axis: ConstraintAxis;
  direction: BoundDirection;
  value: number;
}

export interface SkippedCandidate {
  axis: ConstraintAxis;
  direction: BoundDirection;
  value: number;
  reason: "work_area_flush" | "initial_frame" | "no_delta";
}

export interface LearningInput {
  outcome: GeometryOutcome;
  requested: Frame;
  observed: Frame;
  /** Untouched frame at operation start (initial-frame guard). */
  initial: Frame;
  workArea: Frame;
  tolerance: number;
  /** Repeated guarded writes confirmed a clamp equal to the initial frame. */
  confirmed?: boolean | undefined;
}

const flushGuard = (
  observed: Frame,
  workArea: Frame,
  axis: ConstraintAxis,
  direction: BoundDirection,
): boolean => {
  if (axis === "width") {
    return (
      (direction === "min" && Math.abs(observed.x - workArea.x) <= WORK_AREA_FLUSH_GUARD_PT) ||
      Math.abs(observed.x + observed.width - (workArea.x + workArea.width)) <=
        WORK_AREA_FLUSH_GUARD_PT
    );
  }
  return (
    (direction === "min" && Math.abs(observed.y - workArea.y) <= WORK_AREA_FLUSH_GUARD_PT) ||
    Math.abs(observed.y + observed.height - (workArea.y + workArea.height)) <=
      WORK_AREA_FLUSH_GUARD_PT
  );
};

export interface CandidateScan {
  candidates: ConstraintCandidate[];
  skipped: SkippedCandidate[];
}

/**
 * Extract learnable bound candidates from a classified write. Direction:
 * observed > requested ⇒ minimum candidate; observed < requested ⇒ maximum.
 * Learnable sources: `constrained` and `stableClamp` only — never `progressing`.
 */
export function candidatesFrom(input: LearningInput): CandidateScan {
  const scan: CandidateScan = { candidates: [], skipped: [] };
  if (input.outcome !== "constrained" && input.outcome !== "stableClamp") return scan;

  for (const axis of ["width", "height"] as const) {
    const delta = input.observed[axis] - input.requested[axis];
    if (Math.abs(delta) <= input.tolerance) {
      continue;
    }
    const direction: BoundDirection = delta > 0 ? "min" : "max";
    const value = input.observed[axis];

    if (flushGuard(input.observed, input.workArea, axis, direction)) {
      scan.skipped.push({ axis, direction, value, reason: "work_area_flush" });
      continue;
    }
    // Initial-frame guard: "window didn't move" is not a size limit. Only the
    // stable clamp path needs this; a constrained match hit a KNOWN bound.
    if (
      input.outcome === "stableClamp" &&
      input.confirmed !== true &&
      Math.abs(value - input.initial[axis]) <= input.tolerance
    ) {
      scan.skipped.push({ axis, direction, value, reason: "initial_frame" });
      continue;
    }
    scan.candidates.push({ axis, direction, value });
  }
  return scan;
}

// ---------------------------------------------------------------------------
// Profile store
// ---------------------------------------------------------------------------

const pendingId = (axis: ConstraintAxis, direction: BoundDirection): string =>
  `${axis}:${direction}`;

export function profileKeyString(key: ProfileKey): string {
  return [key.application, key.role, key.subrole ?? "", key.contextFingerprint].join("\u0000");
}

/** FNV-1a over a string; no crypto dependencies in engine code. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Context partition: topology geometry (+ optional OS version). Constraints
 * learned under one topology do NOT verify under another. */
export function contextFingerprint(topology: TopologyObservation, osVersion?: string): string {
  const parts = [...topology.displays]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(
      (d) =>
        `${d.id}|${d.frame.x},${d.frame.y},${d.frame.width},${d.frame.height}` +
        `|${d.workArea.x},${d.workArea.y},${d.workArea.width},${d.workArea.height}`,
    );
  if (osVersion !== undefined) parts.push(osVersion);
  return fingerprint(parts.join(";"));
}

export interface ProfileKeyInput {
  application: string;
  role: string;
  subrole?: string | undefined;
  contextFingerprint: string;
}

export function makeProfileKey(input: ProfileKeyInput): ProfileKey {
  const key: ProfileKey = {
    application: input.application,
    role: input.role,
    contextFingerprint: input.contextFingerprint,
  };
  if (input.subrole !== undefined) key.subrole = input.subrole;
  return key;
}

export interface LearningStore {
  profiles: ReadonlyMap<string, Profile>;
  pending: ReadonlyMap<string, ReadonlyMap<string, readonly number[]>>;
}

export const emptyLearningStore = (): LearningStore => ({
  profiles: new Map(),
  pending: new Map(),
});

export function confidenceFor(sampleCount: number): Confidence {
  if (sampleCount >= STRONG_CONFIDENCE_SAMPLES) return "strong";
  if (sampleCount >= LEARNED_CONFIDENCE_SAMPLES) return "learned";
  return "tentative";
}

/** Monotone tightening for promotion: min takes max(), max takes min(). */
const withBound = (
  constraints: Constraints,
  axis: ConstraintAxis,
  direction: BoundDirection,
  value: number,
): Constraints => {
  if (direction === "min") {
    return axis === "width"
      ? {
          ...constraints,
          minWidth:
            constraints.minWidth === undefined ? value : Math.max(constraints.minWidth, value),
        }
      : {
          ...constraints,
          minHeight:
            constraints.minHeight === undefined ? value : Math.max(constraints.minHeight, value),
        };
  }
  return axis === "width"
    ? {
        ...constraints,
        maxWidth:
          constraints.maxWidth === undefined ? value : Math.min(constraints.maxWidth, value),
      }
    : {
        ...constraints,
        maxHeight:
          constraints.maxHeight === undefined ? value : Math.min(constraints.maxHeight, value),
      };
};

/** Contradiction replacement sets the bound directly (no monotone clamp):
 * bounds can be wrong after OS updates, observation wins. */
const replaceBound = (
  constraints: Constraints,
  axis: ConstraintAxis,
  direction: BoundDirection,
  value: number,
): Constraints => {
  if (direction === "min") {
    return axis === "width"
      ? { ...constraints, minWidth: value }
      : { ...constraints, minHeight: value };
  }
  return axis === "width"
    ? { ...constraints, maxWidth: value }
    : { ...constraints, maxHeight: value };
};

const copyBucket = (
  source: ReadonlyMap<string, readonly number[]> | undefined,
): Map<string, number[]> => {
  const out = new Map<string, number[]>();
  if (source !== undefined) {
    for (const [k, v] of source) out.set(k, [...v]);
  }
  return out;
};

export interface RecordResult {
  store: LearningStore;
  promoted: ConstraintCandidate[];
}

export interface NoteExactFrameResult {
  store: LearningStore;
  replaced: ConstraintCandidate[];
}

/**
 * Feed candidate evidence into the store. PROMOTION_SAMPLES consistent samples
 * within ±PROMOTION_CONSISTENCY_PT promote to a learned bound; learned bounds
 * tighten monotonically (min takes max, max takes min).
 */
export function recordCandidates(
  store: LearningStore,
  key: ProfileKey,
  candidates: readonly ConstraintCandidate[],
): RecordResult {
  if (candidates.length === 0) return { store, promoted: [] };
  const keyStr = profileKeyString(key);

  const pending = new Map(store.pending);
  const bucket = copyBucket(pending.get(keyStr));
  const promoted: ConstraintCandidate[] = [];

  for (const candidate of candidates) {
    const id = pendingId(candidate.axis, candidate.direction);
    const samples: number[] = [...(bucket.get(id) ?? []), candidate.value];
    if (samples.length < PROMOTION_SAMPLES) {
      bucket.set(id, samples);
      continue;
    }
    // Consistent = every sample within ±1 pt of the others.
    const spread = Math.max(...samples) - Math.min(...samples);
    if (spread > PROMOTION_CONSISTENCY_PT) {
      // Not yet consistent: keep the most recent window of samples.
      bucket.set(id, samples.slice(-(PROMOTION_SAMPLES - 1)));
      continue;
    }
    bucket.set(id, []);
    promoted.push(candidate);
  }

  const profiles = new Map(store.profiles);
  if (promoted.length > 0) {
    const existing = profiles.get(keyStr);
    let constraints: Constraints = existing === undefined ? {} : existing.constraints;
    for (const p of promoted) constraints = withBound(constraints, p.axis, p.direction, p.value);
    const priorSamples = existing?.sampleCount ?? 0;
    const sampleCount = priorSamples + promoted.length * PROMOTION_SAMPLES;
    const profile: Profile = {
      key,
      constraints,
      sampleCount,
      confidence: confidenceFor(sampleCount),
      correctiveAttemptCount: existing?.correctiveAttemptCount ?? 0,
      cooperative: existing?.cooperative ?? false,
    };
    profiles.set(keyStr, profile);
  }

  return {
    store: { profiles, pending: pending.set(keyStr, bucket) },
    promoted,
  };
}

/** Explicit diagnostics are already verified evidence and replace the four
 * measured bounds atomically instead of passing through promotion buckets. */
export function setVerifiedConstraints(
  store: LearningStore,
  key: ProfileKey,
  constraints: Constraints,
): LearningStore {
  const keyStr = profileKeyString(key);
  const existing = store.profiles.get(keyStr);
  const profiles = new Map(store.profiles);
  profiles.set(keyStr, {
    key,
    constraints: { ...constraints },
    sampleCount: (existing?.sampleCount ?? 0) + Object.keys(constraints).length,
    confidence: "strong",
    correctiveAttemptCount: existing?.correctiveAttemptCount ?? 0,
    cooperative: existing?.cooperative ?? false,
  });
  return { ...store, profiles };
}

/**
 * An exact observation contradicting a learned bound replaces it — bounds can
 * be wrong after OS updates — and resets pending samples for that bound.
 */
export function noteExactFrame(
  store: LearningStore,
  key: ProfileKey,
  observed: Frame,
  tolerance: number,
): NoteExactFrameResult {
  const keyStr = profileKeyString(key);
  const profile = store.profiles.get(keyStr);
  if (profile === undefined) return { store, replaced: [] };

  const contradictions: ConstraintCandidate[] = [];
  const c = profile.constraints;
  const check = (
    value: number,
    bound: number | undefined,
    axis: ConstraintAxis,
    direction: BoundDirection,
  ): void => {
    if (bound === undefined) return;
    if (direction === "min" && value >= bound - tolerance) return;
    if (direction === "max" && value <= bound + tolerance) return;
    contradictions.push({ axis, direction, value });
  };
  check(observed.width, c.minWidth, "width", "min");
  check(observed.width, c.maxWidth, "width", "max");
  check(observed.height, c.minHeight, "height", "min");
  check(observed.height, c.maxHeight, "height", "max");

  if (contradictions.length === 0) return { store, replaced: [] };

  let constraints: Constraints = profile.constraints;
  for (const contradiction of contradictions) {
    constraints = replaceBound(
      constraints,
      contradiction.axis,
      contradiction.direction,
      contradiction.value,
    );
  }

  const pending = new Map(store.pending);
  const bucket = copyBucket(pending.get(keyStr));
  for (const contradiction of contradictions) {
    bucket.set(pendingId(contradiction.axis, contradiction.direction), []);
  }

  const profiles = new Map(store.profiles);
  profiles.set(keyStr, {
    ...profile,
    constraints,
    sampleCount: profile.sampleCount + contradictions.length,
    confidence: confidenceFor(profile.sampleCount + contradictions.length),
  });

  return {
    store: { profiles, pending: pending.set(keyStr, bucket) },
    replaced: contradictions,
  };
}

/** Mark cooperation state after resistant behavior (fallbacks needed). */
export function markCooperation(
  store: LearningStore,
  key: ProfileKey,
  corrective: boolean,
): LearningStore {
  const keyStr = profileKeyString(key);
  const existing = store.profiles.get(keyStr);
  if (existing === undefined && !corrective) return store;
  const profile: Profile = existing
    ? {
        ...existing,
        correctiveAttemptCount: corrective
          ? existing.correctiveAttemptCount + 1
          : existing.correctiveAttemptCount,
        cooperative: corrective ? true : existing.cooperative,
      }
    : {
        key,
        constraints: {},
        sampleCount: 0,
        confidence: "tentative",
        correctiveAttemptCount: corrective ? 1 : 0,
        cooperative: corrective,
      };
  const profiles = new Map(store.profiles);
  profiles.set(keyStr, profile);
  return { ...store, profiles };
}

// ---------------------------------------------------------------------------
// Viability — docs/rewrite/engine-guide.md, margins ±1 pt
// ---------------------------------------------------------------------------

export const isMinViable = (observed: number, bound: number): boolean =>
  observed + VIABILITY_MARGIN_PT < bound || Math.abs(observed - bound) < VIABILITY_MARGIN_PT;

export const isMaxViable = (observed: number, bound: number): boolean =>
  observed - VIABILITY_MARGIN_PT > bound || Math.abs(observed - bound) < VIABILITY_MARGIN_PT;

/** Filter bounds to those still viable against a live observation. */
export function viableConstraints(
  constraints: Constraints | undefined,
  observed: Frame,
): Constraints {
  if (constraints === undefined) return {};
  let out: Constraints = {};
  const { minWidth, maxWidth, minHeight, maxHeight } = constraints;
  if (minWidth !== undefined && isMinViable(observed.width, minWidth)) {
    out = { ...out, minWidth };
  }
  if (maxWidth !== undefined && isMaxViable(observed.width, maxWidth)) {
    out = { ...out, maxWidth };
  }
  if (minHeight !== undefined && isMinViable(observed.height, minHeight)) {
    out = { ...out, minHeight };
  }
  if (maxHeight !== undefined && isMaxViable(observed.height, maxHeight)) {
    out = { ...out, maxHeight };
  }
  return out;
}

/** Merge platform-reported constraints with viable learned bounds. */
export function effectiveConstraints(
  platformReported: Constraints | undefined,
  learned: Constraints | undefined,
  observed: Frame,
): Constraints {
  const viable = viableConstraints(learned, observed);
  let merged: Constraints = platformReported === undefined ? {} : { ...platformReported };
  if (viable.minWidth !== undefined) {
    merged = {
      ...merged,
      minWidth:
        merged.minWidth === undefined
          ? viable.minWidth
          : Math.max(merged.minWidth, viable.minWidth),
    };
  }
  if (viable.maxWidth !== undefined) {
    merged = {
      ...merged,
      maxWidth:
        merged.maxWidth === undefined
          ? viable.maxWidth
          : Math.min(merged.maxWidth, viable.maxWidth),
    };
  }
  if (viable.minHeight !== undefined) {
    merged = {
      ...merged,
      minHeight:
        merged.minHeight === undefined
          ? viable.minHeight
          : Math.max(merged.minHeight, viable.minHeight),
    };
  }
  if (viable.maxHeight !== undefined) {
    merged = {
      ...merged,
      maxHeight:
        merged.maxHeight === undefined
          ? viable.maxHeight
          : Math.min(merged.maxHeight, viable.maxHeight),
    };
  }
  return merged;
}

export const evidenceSourceFor = (probeBased: boolean): EvidenceSource =>
  probeBased ? "behavioral_probe" : "geometry_operation";
