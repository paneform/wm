import { describe, expect, test } from "vitest";
import { Schema } from "effect";
import {
  classifyWrite,
  ladderStartIndex,
  strategyAt,
  type ClassifyInput,
} from "../src/geometry.ts";
import { candidatesFrom, type LearningInput } from "../src/learn.ts";
import {
  DEFAULT_ATTEMPTS,
  DEFAULT_TOLERANCE,
  MAX_ATTEMPTS,
  MAX_TOLERANCE,
  MIN_ATTEMPTS,
  MIN_TOLERANCE,
  POSITION_VERIFY_TOLERANCE,
  RETRY_LADDER,
  SETTLE_MAX_READS,
  WORK_AREA_FLUSH_GUARD_PT,
} from "../src/constants.ts";
import {
  GeometryRequest,
  type Constraints,
  type Frame,
  type GeometryOutcome,
} from "../src/schema.ts";

const f = (x: number, y: number, width: number, height: number): Frame => ({
  x,
  y,
  width,
  height,
});

const classify = (
  input: Pick<ClassifyInput, "requested" | "observed"> &
    Partial<Omit<ClassifyInput, "requested" | "observed">>,
): GeometryOutcome =>
  classifyWrite({ tolerance: DEFAULT_TOLERANCE, stable: true, ...input });

const learnScan = (
  input: Pick<LearningInput, "outcome" | "requested" | "observed"> &
    Partial<Omit<LearningInput, "outcome" | "requested" | "observed">>,
) =>
  candidatesFrom({
    tolerance: DEFAULT_TOLERANCE,
    initial: input.requested,
    workArea: FAR_WORK_AREA,
    ...input,
  });

const FAR_WORK_AREA = f(-1000, -1000, 9000, 9000);

describe("classifyWrite outcomes", () => {
  test("exact: observed within tolerance of requested", () => {
    expect(classify({ requested: f(100, 50, 800, 600), observed: f(100, 50, 800, 600) })).toBe("exact");
    expect(classify({ requested: f(100, 50, 800, 600), observed: f(101, 50, 799, 601) })).toBe("exact");
    expect(classify({ requested: f(100, 50, 800, 600), observed: f(101, 50, 799, 601), tolerance: 0 })).toBe("failed");
  });

  test("constrained: matches a KNOWN learned bound with position honored", () => {
    const constraints: Constraints = { minWidth: 800 };
    expect(
      classify({
        requested: f(10, 20, 700, 500),
        observed: f(10, 20, 800, 500),
        constraints,
      }),
    ).toBe("constrained");

    expect(
      classify({
        requested: f(0, 0, 600, 400),
        observed: f(0, 0, 600, 300),
        constraints: { maxHeight: 300 },
      }),
    ).toBe("constrained");
  });

  test("the same clamp without a known constraint is stableClamp candidate evidence instead", () => {
    expect(
      classify({
        requested: f(10, 20, 700, 500),
        observed: f(10, 20, 800, 500),
        initialFrame: f(10, 20, 700, 500),
      }),
    ).toBe("stableClamp");
  });

  test("constrained requires the position to hold; drifting position fails", () => {
    expect(
      classify({
        requested: f(10, 20, 700, 500),
        observed: f(22, 20, 800, 500),
        constraints: { minWidth: 800 },
      }),
    ).toBe("failed");
  });

  test("progressing: distance to target decreased vs previous read; stability not required", () => {
    expect(
      classify({
        requested: f(0, 0, 900, 600),
        observed: f(0, 0, 650, 600),
        previousObserved: f(0, 0, 400, 600),
        stable: false,
      }),
    ).toBe("progressing");
  });

  test("stableClamp: position honored, size differs from BOTH requested and initial frame", () => {
    expect(
      classify({
        requested: f(0, 0, 600, 400),
        observed: f(0, 0, 700, 400),
        initialFrame: f(0, 0, 500, 400),
      }),
    ).toBe("stableClamp");

    expect(
      classify({
        requested: f(0, 0, 600, 400),
        observed: f(0, 0, 700, 400),
        initialFrame: f(0, 0, 500, 400),
        stable: false,
      }),
    ).toBe("failed");
  });

  test("a stable readback equal to the untouched initial frame is failed, not stableClamp", () => {
    expect(
      classify({
        requested: f(0, 0, 600, 400),
        observed: f(0, 0, 640, 400),
        initialFrame: f(0, 0, 640, 400),
      }),
    ).toBe("failed");
  });
});

describe("learning guards on the write pipeline (±2pt flush, initial frame)", () => {
  test(`minimum observation flush with any work-area edge within ${WORK_AREA_FLUSH_GUARD_PT} pt is skipped`, () => {
    const scan = learnScan({
      outcome: "stableClamp",
      requested: f(0, 38, 1400, 900),
      observed: f(0, 38, 1512, 944),
      initial: f(0, 38, 1400, 900),
      workArea: f(0, 38, 1512, 944),
    });
    expect(scan.candidates).toEqual([]);
    expect(scan.skipped).toEqual([
      { axis: "width", direction: "min", value: 1512, reason: "work_area_flush" },
      { axis: "height", direction: "min", value: 944, reason: "work_area_flush" },
    ]);
  });

  test("a leading-edge tile can teach an interior maximum", () => {
    const scan = learnScan({
      outcome: "stableClamp",
      requested: f(0, 32, 1512, 950),
      observed: f(0, 32, 723, 950),
      initial: f(-722, 930, 723, 950),
      workArea: f(0, 32, 1512, 950),
      confirmed: true,
    });

    expect(scan.candidates).toEqual([{ axis: "width", direction: "max", value: 723 }]);
    expect(scan.skipped).toEqual([]);
  });

  test("a trailing-edge maximum remains protected as display-clamped evidence", () => {
    const scan = learnScan({
      outcome: "stableClamp",
      requested: f(789, 32, 1000, 950),
      observed: f(789, 32, 723, 950),
      initial: f(0, 32, 723, 950),
      workArea: f(0, 32, 1512, 950),
      confirmed: true,
    });

    expect(scan.candidates).toEqual([]);
    expect(scan.skipped).toEqual([
      { axis: "width", direction: "max", value: 723, reason: "work_area_flush" },
    ]);
  });

  test("a top-edge tile can teach an interior maximum height", () => {
    const accepted = learnScan({
      outcome: "stableClamp",
      requested: f(100, 32, 600, 950),
      observed: f(100, 32, 600, 700),
      initial: f(100, 282, 600, 700),
      workArea: f(0, 32, 1512, 950),
      confirmed: true,
    });
    const bottomClamped = learnScan({
      outcome: "stableClamp",
      requested: f(100, 282, 600, 950),
      observed: f(100, 282, 600, 700),
      initial: f(100, 32, 600, 700),
      workArea: f(0, 32, 1512, 950),
      confirmed: true,
    });

    expect(accepted.candidates).toEqual([{ axis: "height", direction: "max", value: 700 }]);
    expect(bottomClamped.candidates).toEqual([]);
    expect(bottomClamped.skipped).toEqual([
      { axis: "height", direction: "max", value: 700, reason: "work_area_flush" },
    ]);
  });

  test("flush guard is per-axis and inclusive at exactly ±2 pt", () => {
    const partial = learnScan({
      outcome: "stableClamp",
      requested: f(0, 238, 1400, 300),
      observed: f(0, 238, 1512, 400),
      initial: f(0, 238, 1400, 300),
      workArea: f(0, 38, 1512, 944),
    });
    expect(partial.skipped).toEqual([
      { axis: "width", direction: "min", value: 1512, reason: "work_area_flush" },
    ]);
    expect(partial.candidates).toEqual([{ axis: "height", direction: "min", value: 400 }]);

    const atTwo = learnScan({
      outcome: "stableClamp",
      requested: f(100, 200, 1400, 300),
      observed: f(100, 200, 1410, 300),
      initial: f(100, 200, 1400, 300),
      workArea: f(0, 38, 1512, 944),
    });
    expect(atTwo.candidates).toEqual([]);

    const atThree = learnScan({
      outcome: "stableClamp",
      requested: f(100, 200, 1400, 300),
      observed: f(100, 200, 1409, 300),
      initial: f(100, 200, 1400, 300),
      workArea: f(0, 38, 1512, 944),
    });
    expect(atThree.candidates).toEqual([{ axis: "width", direction: "min", value: 1409 }]);
  });

  test("initial-frame guard: per-axis 'window did not grow' is never evidence of a size limit", () => {
    const scan = learnScan({
      outcome: "stableClamp",
      requested: f(-500, -300, 700, 500),
      observed: f(-500, -300, 600, 640),
      initial: f(-500, -300, 600, 500),
      workArea: FAR_WORK_AREA,
    });
    expect(scan.candidates).toEqual([{ axis: "height", direction: "min", value: 640 }]);
    expect(scan.skipped).toEqual([
      { axis: "width", direction: "max", value: 600, reason: "initial_frame" },
    ]);
  });

  test("confirmed repeated evidence bypasses only the initial-frame guard", () => {
    const scan = learnScan({
      outcome: "stableClamp",
      requested: f(1134, 32, 378, 950),
      observed: f(1134, 32, 480, 950),
      initial: f(1134, 32, 480, 950),
      workArea: f(0, 32, 1512, 950),
      confirmed: true,
    });
    expect(scan.candidates).toEqual([{ axis: "width", direction: "min", value: 480 }]);
    expect(scan.skipped).toEqual([]);

    const flush = learnScan({
      outcome: "stableClamp",
      requested: f(0, 32, 378, 950),
      observed: f(0, 32, 480, 950),
      initial: f(0, 32, 480, 950),
      workArea: f(0, 32, 1512, 950),
      confirmed: true,
    });
    expect(flush.candidates).toEqual([]);
    expect(flush.skipped).toEqual([
      { axis: "width", direction: "min", value: 480, reason: "work_area_flush" },
    ]);
  });

  test("progressing outcomes are never learnable", () => {
    const scan = learnScan({
      outcome: "progressing",
      requested: f(0, 0, 900, 600),
      observed: f(0, 0, 650, 600),
      initial: f(0, 0, 400, 600),
      workArea: FAR_WORK_AREA,
    });
    expect(scan).toEqual({ candidates: [], skipped: [] });
  });
});

describe("retry ladder", () => {
  test("strategy ordering is [positionSize, sizeOnly, sizePositionSize, convergedSizePositionSize]", () => {
    expect([...RETRY_LADDER]).toEqual([
      "positionSize",
      "sizeOnly",
      "sizePositionSize",
      "convergedSizePositionSize",
    ]);
    expect(strategyAt(0)).toBe("positionSize");
    expect(strategyAt(1)).toBe("sizeOnly");
    expect(strategyAt(2)).toBe("sizePositionSize");
    expect(strategyAt(3)).toBe("convergedSizePositionSize");
    expect(strategyAt(-3)).toBe("positionSize");
    expect(strategyAt(RETRY_LADDER.length + 5)).toBe("convergedSizePositionSize");
  });

  test("profile-informed early skip: correctiveAttemptCount > 1 starts one rung up the ladder", () => {
    expect(ladderStartIndex(undefined)).toBe(0);
    expect(ladderStartIndex(0)).toBe(0);
    expect(ladderStartIndex(1)).toBe(0);
    expect(ladderStartIndex(2)).toBe(1);
    expect(ladderStartIndex(7)).toBe(1);
    expect(strategyAt(ladderStartIndex(1))).toBe("positionSize");
    expect(strategyAt(ladderStartIndex(2))).toBe("sizeOnly");
  });
});

describe("request validation bounds", () => {
  const decode = Schema.decodeUnknownSync(GeometryRequest);
  const base = { windowId: "w", frame: f(0, 0, 100, 100) };

  test("attempts outside 1–5 or non-integer are rejected before any platform call", () => {
    expect(() => decode({ ...base, attempts: 0 })).toThrow();
    expect(() => decode({ ...base, attempts: 6 })).toThrow();
    expect(() => decode({ ...base, attempts: 2.5 })).toThrow();
    for (const attempts of [MIN_ATTEMPTS, DEFAULT_ATTEMPTS, MAX_ATTEMPTS]) {
      expect(decode({ ...base, attempts })).toMatchObject({ attempts });
    }
  });

  test("documented numeric constants match docs/rewrite/domain-schema.md", () => {
    expect(DEFAULT_TOLERANCE).toBe(1);
    expect(MIN_TOLERANCE).toBe(0);
    expect(MAX_TOLERANCE).toBe(20);
    expect(DEFAULT_ATTEMPTS).toBe(3);
    expect(MIN_ATTEMPTS).toBe(1);
    expect(MAX_ATTEMPTS).toBe(5);
    expect(WORK_AREA_FLUSH_GUARD_PT).toBe(2);
    expect(POSITION_VERIFY_TOLERANCE).toBe(1);
    expect(SETTLE_MAX_READS).toBe(11);
  });
});
