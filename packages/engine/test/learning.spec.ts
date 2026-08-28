import { describe, expect, test } from "vitest";
import {
  candidatesFrom,
  confidenceFor,
  contextFingerprint,
  effectiveConstraints,
  emptyLearningStore,
  isMaxViable,
  isMinViable,
  makeProfileKey,
  noteExactFrame,
  profileKeyString,
  recordCandidates,
  viableConstraints,
  type ConstraintCandidate,
  type LearningStore,
} from "../src/learn.ts";
import {
  LEARNED_CONFIDENCE_SAMPLES,
  PROMOTION_CONSISTENCY_PT,
  PROMOTION_SAMPLES,
  STRONG_CONFIDENCE_SAMPLES,
  VIABILITY_MARGIN_PT,
} from "../src/constants.ts";
import type { Constraints, Frame, TopologyObservation } from "../src/schema.ts";
import type { ProfileKey } from "../src/world.ts";
import { makeDisplay } from "./helpers/fake-platform.ts";

const f = (x: number, y: number, width: number, height: number): Frame => ({
  x,
  y,
  width,
  height,
});

const FP_A = "aaaa0000";
const FP_B = "bbbb1111";

const keyFor = (fingerprint: string): ProfileKey =>
  makeProfileKey({
    application: "com.example.editor",
    role: "AXWindow",
    contextFingerprint: fingerprint,
  });

const KEY_A = keyFor(FP_A);
const KEY_B = keyFor(FP_B);

const candidate = (
  axis: "width" | "height",
  direction: "min" | "max",
  value: number,
): ConstraintCandidate => ({ axis, direction, value });

const storeWithProfile = (key: ProfileKey, constraints: Constraints): LearningStore => ({
  profiles: new Map([
    [
      profileKeyString(key),
      {
        key,
        constraints,
        sampleCount: PROMOTION_SAMPLES,
        confidence: "learned",
        correctiveAttemptCount: 0,
        cooperative: false,
      },
    ],
  ]),
  pending: new Map(),
});

describe("constraint promotion", () => {
  test(`${PROMOTION_SAMPLES} consistent samples within ±${PROMOTION_CONSISTENCY_PT} pt promote; 2 do not`, () => {
    let store = emptyLearningStore();

    store = recordCandidates(store, KEY_A, [candidate("width", "min", 800)]).store;
    expect(store.profiles.size).toBe(0);

    store = recordCandidates(store, KEY_A, [candidate("width", "min", 801)]).store;
    expect(store.profiles.size).toBe(0);

    const third = recordCandidates(store, KEY_A, [candidate("width", "min", 800)]);
    expect(third.promoted).toEqual([candidate("width", "min", 800)]);

    const profile = third.store.profiles.get(profileKeyString(KEY_A))!;
    expect(profile.constraints.minWidth).toBe(800);
    expect(profile.sampleCount).toBe(PROMOTION_SAMPLES);
    expect(profile.confidence).toBe("learned");
    const bucket = third.store.pending.get(profileKeyString(KEY_A))!.get("width:min")!;
    expect(bucket).toEqual([]);
  });

  test(`an inconsistent sample window never promotes (spread > ±${PROMOTION_CONSISTENCY_PT} pt keeps sliding)`, () => {
    let store = emptyLearningStore();
    for (const value of [800, 850, 800, 800]) {
      const result = recordCandidates(store, KEY_A, [candidate("width", "min", value)]);
      store = result.store;
      expect(result.promoted).toEqual([]);
    }
    expect(store.profiles.size).toBe(0);
    expect(store.pending.get(profileKeyString(KEY_A))!.get("width:min")).toEqual([800, 800]);
  });

  test(`confidence tiers: ≥${STRONG_CONFIDENCE_SAMPLES} strong, ≥${LEARNED_CONFIDENCE_SAMPLES} learned, else tentative`, () => {
    expect(confidenceFor(2)).toBe("tentative");
    expect(confidenceFor(LEARNED_CONFIDENCE_SAMPLES)).toBe("learned");
    expect(confidenceFor(7)).toBe("learned");
    expect(confidenceFor(STRONG_CONFIDENCE_SAMPLES)).toBe("strong");
  });
});

describe("work-area-flushing clamps NEVER learn", () => {
  test("a clamp flush against every work-area edge is recorded as skipped and promotes nothing (regression wm-45sa)", () => {
    const workArea = f(0, 38, 1512, 944);
    const requested = f(0, 38, 1400, 900);
    const observed = f(0, 38, 1512, 944);

    const scan = candidatesFrom({
      outcome: "stableClamp",
      requested,
      observed,
      initial: requested,
      workArea,
      tolerance: 1,
    });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped.map((s) => s.reason)).toEqual(["work_area_flush", "work_area_flush"]);

    const result = recordCandidates(emptyLearningStore(), KEY_A, scan.candidates);
    expect(result.promoted).toEqual([]);
    expect(result.store.profiles.size).toBe(0);
    expect(result.store.pending.get(profileKeyString(KEY_A))).toBeUndefined();
  });

  test("repeated trailing-edge maximum evidence never becomes pending or promoted", () => {
    const scan = candidatesFrom({
      outcome: "stableClamp",
      requested: f(789, 38, 1000, 900),
      observed: f(789, 38, 723, 900),
      initial: f(0, 38, 723, 900),
      workArea: f(0, 38, 1512, 944),
      tolerance: 1,
      confirmed: true,
    });
    let store = emptyLearningStore();
    for (let sample = 0; sample < 3; sample += 1) {
      store = recordCandidates(store, KEY_A, scan.candidates).store;
    }

    expect(scan.candidates).toEqual([]);
    expect(store.pending.get(profileKeyString(KEY_A))).toBeUndefined();
    expect(store.profiles.get(profileKeyString(KEY_A))).toBeUndefined();
  });
});

describe("monotone tightening of learned bounds", () => {
  test(`promotion tightens: min takes max(), max takes min() (margin ±${VIABILITY_MARGIN_PT} pt untouched)`, () => {
    let store = storeWithProfile(KEY_A, { minWidth: 700, maxWidth: 900 });

    store = recordCandidates(store, KEY_A, [
      candidate("width", "min", 750),
      candidate("width", "min", 750),
      candidate("width", "min", 750),
    ]).store;
    expect(store.profiles.get(profileKeyString(KEY_A))!.constraints.minWidth).toBe(750);

    store = recordCandidates(store, KEY_A, [
      candidate("width", "max", 850),
      candidate("width", "max", 850),
      candidate("width", "max", 850),
    ]).store;
    const tightened = store.profiles.get(profileKeyString(KEY_A))!;
    expect(tightened.constraints.maxWidth).toBe(850);
    expect(tightened.constraints.minWidth).toBe(750);

    const loosening = recordCandidates(store, KEY_A, [
      candidate("width", "min", 700),
      candidate("width", "min", 700),
      candidate("width", "min", 700),
    ]);
    expect(loosening.promoted).toEqual([candidate("width", "min", 700)]);
    expect(loosening.store.profiles.get(profileKeyString(KEY_A))!.constraints.minWidth).toBe(750);
  });
});

describe("exact observations contradicting learned bounds", () => {
  test("a contradicting exact frame replaces the bound directly and resets pending samples", () => {
    const keyStr = profileKeyString(KEY_A);
    const pendingAxis = new Map([["width:max", [795, 796]]]);
    const store: LearningStore = {
      profiles: new Map([
        [
          keyStr,
          {
            key: KEY_A,
            constraints: { maxWidth: 800 },
            sampleCount: PROMOTION_SAMPLES,
            confidence: "learned",
            correctiveAttemptCount: 0,
            cooperative: false,
          },
        ],
      ]),
      pending: new Map([[keyStr, pendingAxis]]),
    };

    const result = noteExactFrame(store, KEY_A, f(0, 0, 900, 500), 1);
    expect(result.replaced).toEqual([candidate("width", "max", 900)]);
    const profile = result.store.profiles.get(keyStr)!;
    expect(profile.constraints.maxWidth).toBe(900);
    expect(result.store.pending.get(keyStr)!.get("width:max")).toEqual([]);
  });

  test("a contradicting exact frame below a learned minimum replaces the minimum", () => {
    const store = storeWithProfile(KEY_A, { minHeight: 700 });
    const result = noteExactFrame(store, KEY_A, f(0, 0, 500, 500), 1);
    expect(result.replaced).toEqual([candidate("height", "min", 500)]);
    expect(result.store.profiles.get(profileKeyString(KEY_A))!.constraints.minHeight).toBe(500);
  });

  test("an exact frame within tolerance of a bound contradicts nothing and leaves the store alone", () => {
    const store = storeWithProfile(KEY_A, { maxWidth: 800 });
    const result = noteExactFrame(store, KEY_A, f(0, 0, 800, 500), 1);
    expect(result.replaced).toEqual([]);
    expect(result.store.profiles.get(profileKeyString(KEY_A))!.constraints.maxWidth).toBe(800);
  });
});

describe("topology-fingerprint partitioning", () => {
  const topologyA: TopologyObservation = { displays: [makeDisplay()] };
  const topologyB: TopologyObservation = {
    displays: [
      makeDisplay({
        frame: { x: 0, y: 0, width: 1920, height: 1080 },
        workArea: { x: 0, y: 38, width: 1920, height: 1042 },
      }),
    ],
  };

  test("different display geometry produces different context fingerprints", () => {
    expect(contextFingerprint(topologyA)).not.toBe(contextFingerprint(topologyB));
  });

  test("display order does not affect the fingerprint; OS version does", () => {
    const primary = makeDisplay();
    const secondary = makeDisplay({
      id: "display:sim-secondary",
      frame: { x: -1920, y: 0, width: 1920, height: 1080 },
      workArea: { x: -1920, y: 38, width: 1920, height: 1042 },
    });
    const one: TopologyObservation = { displays: [primary, secondary] };
    const two: TopologyObservation = { displays: [secondary, primary] };
    expect(contextFingerprint(one)).toBe(contextFingerprint(two));
    expect(contextFingerprint(one, "14.5")).not.toBe(contextFingerprint(one, "15.0"));
    expect(contextFingerprint(one)).not.toBe(contextFingerprint(one, "14.5"));
  });

  test("constraints learned under topology A stay partitioned away from topology B", () => {
    let store = emptyLearningStore();
    store = recordCandidates(store, KEY_A, [
      candidate("width", "min", 800),
      candidate("width", "min", 800),
      candidate("width", "min", 800),
    ]).store;

    expect(store.profiles.has(profileKeyString(KEY_A))).toBe(true);
    expect(store.profiles.has(profileKeyString(KEY_B))).toBe(false);

    const probeOtherPartition = noteExactFrame(store, KEY_B, f(0, 0, 5000, 5000), 1);
    expect(probeOtherPartition.replaced).toEqual([]);
    expect(probeOtherPartition.store.profiles.size).toBe(1);
  });
});

describe("viability margins", () => {
  test(`learned min usable iff observed+${VIABILITY_MARGIN_PT} < bound; max iff observed−${VIABILITY_MARGIN_PT} > bound`, () => {
    expect(isMinViable(700, 800)).toBe(true);
    expect(isMinViable(798, 800)).toBe(true);
    expect(isMinViable(799, 800)).toBe(false);
    expect(isMinViable(800, 800)).toBe(true);

    expect(isMaxViable(902, 900)).toBe(true);
    expect(isMaxViable(901, 900)).toBe(false);
    expect(isMaxViable(899, 900)).toBe(false);
    expect(isMaxViable(900, 900)).toBe(true);
  });

  test("viableConstraints keeps only bounds still separated from the live observation by the margin", () => {
    const learned: Constraints = {
      minWidth: 800,
      maxWidth: 1200,
      minHeight: 600,
      maxHeight: 1000,
    };
    expect(viableConstraints(learned, f(0, 0, 700, 1100))).toEqual({
      minWidth: 800,
      maxHeight: 1000,
    });
    expect(viableConstraints(learned, f(0, 0, 900, 800))).toEqual({});
    expect(viableConstraints(learned, f(0, 0, 800, 600))).toEqual({
      minWidth: 800,
      minHeight: 600,
    });
    expect(viableConstraints(undefined, f(0, 0, 900, 800))).toEqual({});
  });

  test("effectiveConstraints merges platform-reported bounds with viable learned bounds", () => {
    const merged = effectiveConstraints(
      { minWidth: 600, maxWidth: 1100 },
      { minWidth: 800, maxWidth: 1200 },
      f(0, 0, 700, 500),
    );
    expect(merged).toEqual({ minWidth: 800, maxWidth: 1100 });
  });
});
