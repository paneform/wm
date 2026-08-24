import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import * as fc from "fast-check";
import {
  CORNER_PRIORITY,
  cornerFeasible,
  cornerTarget,
  defaultParkingVisibility,
  discoverParkingLimits,
  displayParkingFingerprint,
  feasibleCorners,
  findParkingFact,
  intersectsAnyDisplay,
  orderProbeCandidates,
  roundLimitTowardVisible,
  searchBudget,
  withParkingFact,
  type ClampDiscoveryFailure,
  type ClampDiscoverySuccess,
} from "../src/parking.ts";
import type { Clock, PlatformAdapter } from "../src/platform.ts";
import { PlatformError } from "../src/schema.ts";
import type {
  DisplayId,
  DisplayObservation,
  Frame,
  Size,
  WindowId,
  WindowObservation,
  WriteObservation,
} from "../src/schema.ts";
import type { ParkingCorner, ParkingFact, ParkingVisibility } from "../src/world.ts";
import {
  PARKING_ACCEPTANCE_PT,
  PARKING_TYPICAL_VISIBILITY,
  RESTORE_MATCH_THRESHOLD,
} from "../src/constants.ts";
import { createFakePlatform, makeDisplay } from "./helpers/fake-platform.ts";

// Parking behaviors — docs/rewrite/testing-guide.md §Test matrix row "Parking".
// Deterministic only: scripted/seeded platform, virtual clock, seeded fast-check.

const EPS = 1e-9;
const VIRTUAL_CLOCK: Clock = { now: () => 0, sleep: () => Effect.void };

const isLeftCorner = (corner: ParkingCorner): boolean =>
  corner === "bottomLeft" || corner === "topLeft";
const isBottomCorner = (corner: ParkingCorner): boolean =>
  corner === "bottomLeft" || corner === "bottomRight";

const frame = (x: number, y: number, width: number, height: number): Frame => ({
  x,
  y,
  width,
  height,
});

const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
  Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS;

let syntheticWindowCounter = 0;

const makeCandidate = (frameValue: Frame, id?: WindowId): WindowObservation => {
  syntheticWindowCounter += 1;
  return {
    id: id ?? `window:spec:${syntheticWindowCounter}`,
    pid: 7000 + syntheticWindowCounter,
    role: "AXWindow",
    frame: frameValue,
    minimized: false,
    hidden: false,
    fullscreen: false,
    focused: false,
    capabilities: {
      movable: "supported",
      resizable: "supported",
      movableEvidence: "platform_report",
      resizableEvidence: "platform_report",
    },
  };
};

const display = (
  id: DisplayId,
  frameValue: Frame,
  workArea: Frame,
  primary = false,
): DisplayObservation => ({ id, frame: frameValue, workArea, scale: 2, primary });

/** Primary sitting at a negative origin (left of / above a hypothetical primary). */
const NEG_DISPLAY = display(
  "display:neg",
  frame(-1200, -800, 1200, 800),
  frame(-1200, -762, 1200, 762),
  true,
);

const isDiscoverySuccess = (
  r: ClampDiscoverySuccess | ClampDiscoveryFailure,
): r is ClampDiscoverySuccess => "visibility" in r;

// ---------------------------------------------------------------------------
// Scripted OS — monotone integer visibility boundaries per axis, emulating
// macOS offscreen refusal: a request leaving less than the limit visible is
// clamped back to the sliver at exactly the limit. Optional quirks:
//  - driftOnRefusedHorizontal: an x-refusal drags y by DRIFT_PT (the wm-ysdj
//    pathology: the OS moves the OTHER axis while refusing the searched one).
//  - failNextWriteTo / failAllWritesTo: hard position-write failures.
// ---------------------------------------------------------------------------

const DRIFT_PT = 7;

interface ScriptedWindow {
  id: WindowId;
  original: Frame;
}

class ScriptedOs {
  readonly writes: Array<{
    windowId: WindowId;
    point: { x: number; y: number };
    observed: Frame;
    failed: boolean;
  }> = [];
  private readonly frames = new Map<WindowId, Frame>();

  frameOf(id: WindowId): Frame | undefined {
    return this.frames.get(id);
  }
  private readonly rules: Array<{ windowId: WindowId; at: { x: number; y: number }; remaining: number }> =
    [];
  private driftCount = 0;

  constructor(
    private readonly osDisplay: DisplayObservation,
    private readonly corner: ParkingCorner,
    private readonly limits: ParkingVisibility,
    windows: readonly ScriptedWindow[],
    private readonly opts: { driftOnRefusedHorizontal?: boolean } = {},
  ) {
    for (const w of windows) this.frames.set(w.id, { ...w.original });
  }

  failNextWriteTo(windowId: WindowId, at: { x: number; y: number }): void {
    this.rules.push({ windowId, at, remaining: 1 });
  }

  failAllWritesTo(windowId: WindowId): void {
    this.rules.push({ windowId, at: { x: NaN, y: NaN }, remaining: Number.POSITIVE_INFINITY });
  }

  get orthogonalDrifts(): number {
    return this.driftCount;
  }

  /** Raw monotone predicate of the emulated OS: granted iff both axes' visibilities clear their limits. */
  grantedAtVisibility(horizontal: number, vertical: number): boolean {
    return (
      horizontal >= this.limits.horizontal - EPS && vertical >= this.limits.vertical - EPS
    );
  }

  private visibilityOf(id: WindowId, point: { x: number; y: number }): { h: number; v: number } {
    const current = this.frames.get(id);
    if (current === undefined) throw new Error(`unknown scripted window ${id}`);
    const d = this.osDisplay.frame;
    const h = isLeftCorner(this.corner)
      ? point.x + current.width - d.x
      : d.x + d.width - point.x;
    const v = isBottomCorner(this.corner)
      ? d.y + d.height - point.y
      : point.y + current.height - d.y;
    return { h, v };
  }

  private setPosition(
    id: WindowId,
    point: { x: number; y: number },
  ): Effect.Effect<WriteObservation, PlatformError> {
    const current = this.frames.get(id);
    if (current === undefined) {
      return Effect.fail(new PlatformError({ code: "not_found", detail: `unknown ${id}` }));
    }
    const rule = this.rules.find(
      (r) =>
        r.remaining > 0 &&
        r.windowId === id &&
        (Number.isNaN(r.at.x) || samePoint(r.at, point)),
    );
    if (rule !== undefined) {
      rule.remaining -= 1;
      this.writes.push({ windowId: id, point: { ...point }, observed: { ...current }, failed: true });
      return Effect.fail(
        new PlatformError({ code: "rejected", detail: "scripted position refusal" }),
      );
    }
    const size: Size = { width: current.width, height: current.height };
    const { h, v } = this.visibilityOf(id, point);
    let observed: Frame;
    if (this.grantedAtVisibility(h, v)) {
      observed = { x: point.x, y: point.y, width: size.width, height: size.height };
    } else {
      // Per-axis continuous clamp to the measured limits (real macOS retains
      // fractional positions rather than snapping to a corner).
      const clampH = (p: number): number =>
        isLeftCorner(this.corner)
          ? this.osDisplay.frame.x - size.width + this.limits.horizontal
          : this.osDisplay.frame.x + this.osDisplay.frame.width - this.limits.horizontal;
      const clampV = (p: number): number =>
        isBottomCorner(this.corner)
          ? this.osDisplay.frame.y + this.osDisplay.frame.height - this.limits.vertical
          : this.osDisplay.frame.y - size.height + this.limits.vertical;
      const refusedHorizontal = h < this.limits.horizontal - EPS;
      observed = {
        x: refusedHorizontal ? clampH(point.x) : point.x,
        y: v < this.limits.vertical - EPS ? clampV(point.y) : point.y,
        width: size.width,
        height: size.height,
      };
      if (this.opts.driftOnRefusedHorizontal === true && refusedHorizontal) {
        observed = { ...observed, y: observed.y + DRIFT_PT };
        this.driftCount += 1;
      }
    }
    this.frames.set(id, observed);
    this.writes.push({
      windowId: id,
      point: { ...point },
      observed: { ...observed },
      failed: false,
    });
    return Effect.succeed({
      requested: { ...current, x: point.x, y: point.y },
      observed: { ...observed },
      stable: true,
    });
  }

  private observationOf(id: WindowId): WindowObservation {
    const f = this.frames.get(id)!;
    return { ...makeCandidate(f, id), pid: 4242 };
  }

  adapter(): PlatformAdapter {
    const self = this;
    return {
      events: Stream.empty,
      getTopology: () => Effect.succeed({ displays: [self.osDisplay] }),
      getWindows: () =>
        Effect.succeed([...self.frames.keys()].map((id) => self.observationOf(id))),
      getWindow: (id) =>
        Effect.succeed(self.frames.has(id) ? self.observationOf(id) : null),
      setWindowFrame: (id, f) => self.setPosition(id, { x: f.x, y: f.y }),
      setWindowPosition: (id, point) => self.setPosition(id, point),
      setWindowSize: (id, size) => {
        const current = self.frames.get(id);
        if (current === undefined) {
          return Effect.fail(new PlatformError({ code: "not_found", detail: `unknown ${id}` }));
        }
        const next: Frame = { ...current, width: size.width, height: size.height };
        self.frames.set(id, next);
        return Effect.succeed({
          requested: { ...current },
          observed: { ...next },
          stable: true,
        });
      },
      focusWindow: () => Effect.void,
    };
  }
}

const runDiscovery = (
  os: ScriptedOs,
  osDisplay: DisplayObservation,
  displays: readonly DisplayObservation[],
  corner: ParkingCorner,
  candidates: readonly WindowObservation[],
): ClampDiscoverySuccess | ClampDiscoveryFailure =>
  Effect.runSync(
    discoverParkingLimits(
      { adapter: os.adapter(), clock: VIRTUAL_CLOCK },
      osDisplay,
      displays,
      corner,
      candidates,
    ),
  );

// ---------------------------------------------------------------------------
// Corner target math
// ---------------------------------------------------------------------------

describe("corner target math", () => {
  const size: Size = { width: 800, height: 600 };
  const visibility: ParkingVisibility = { horizontal: 3, vertical: 52 };

  test("positive-origin display: documented formulas per corner", () => {
    const d = display("display:a", frame(0, 0, 1512, 982), frame(0, 38, 1512, 944), true);
    // left corners: x = display.x − width + horizontal; right: x = maxX − horizontal
    // bottom corners: y = maxY − vertical; top: y = display.y − height + vertical
    expect(cornerTarget(d, "bottomLeft", size, visibility)).toEqual(frame(-797, 930, 800, 600));
    expect(cornerTarget(d, "bottomRight", size, visibility)).toEqual(frame(1509, 930, 800, 600));
    expect(cornerTarget(d, "topLeft", size, visibility)).toEqual(frame(-797, -548, 800, 600));
    expect(cornerTarget(d, "topRight", size, visibility)).toEqual(frame(1509, -548, 800, 600));
  });

  test("negative-coordinate display (left of/above primary): same formulas hold", () => {
    const d = display("display:neg", frame(-1920, -500, 1920, 1080), frame(-1920, -462, 1920, 1042));
    const small: Size = { width: 640, height: 480 };
    const vis: ParkingVisibility = { horizontal: 2, vertical: 40 };
    // maxX = 0, maxY = 580
    expect(cornerTarget(d, "bottomLeft", small, vis)).toEqual(frame(-2558, 540, 640, 480));
    expect(cornerTarget(d, "bottomRight", small, vis)).toEqual(frame(-2, 540, 640, 480));
    expect(cornerTarget(d, "topLeft", small, vis)).toEqual(frame(-2558, -940, 640, 480));
    expect(cornerTarget(d, "topRight", small, vis)).toEqual(frame(-2, -940, 640, 480));
  });

  test("requested size is echoed in every corner target", () => {
    const d = NEG_DISPLAY;
    for (const corner of CORNER_PRIORITY) {
      const t = cornerTarget(d, corner, { width: 321, height: 237 }, visibility);
      expect(t.width).toBe(321);
      expect(t.height).toBe(237);
    }
  });
});

// ---------------------------------------------------------------------------
// Feasibility — zero-area intersection rule
// ---------------------------------------------------------------------------

describe("corner feasibility (zero-area intersection rule)", () => {
  const self = display("display:self", frame(0, 0, 1000, 700), frame(0, 38, 1000, 662), true);
  const size: Size = { width: 300, height: 200 };
  const visibility: ParkingVisibility = { horizontal: 1, vertical: 52 };

  test("edge touch (zero-area overlap) is allowed on both axes", () => {
    // shares only the right edge of self: zero-width overlap
    const touchingVertically = frame(1000, 0, 300, 200);
    expect(cornerFeasible(touchingVertically, self.id, [self])).toBe(true);
    // shares only the bottom edge of self: zero-height overlap
    const touchingHorizontally = frame(0, 700, 300, 200);
    expect(cornerFeasible(touchingHorizontally, self.id, [self])).toBe(true);
  });

  test(`≥${1} pt overlap in both axes is rejected`, () => {
    const neighbor = display("display:right", frame(1000, 0, 1000, 700), frame(1000, 38, 1000, 662));
    // 1 pt into neighbor horizontally, overlapping vertically ⇒ positive area
    expect(cornerFeasible(frame(999, 0, 300, 200), self.id, [self, neighbor])).toBe(false);
    // 1 pt into neighbor vertically, overlapping horizontally
    expect(cornerFeasible(frame(1100, 699, 300, 200), self.id, [self, neighbor])).toBe(false);
  });

  test("the parked display's own frame never makes its own corners infeasible", () => {
    for (const corner of CORNER_PRIORITY) {
      const t = cornerTarget(self, corner, size, visibility);
      expect(cornerFeasible(t, self.id, [self])).toBe(true);
    }
  });

  test("side-by-side displays allow outward corners only", () => {
    const secondaryLeft = display(
      "display:left",
      frame(-1920, 0, 1920, 982),
      frame(-1920, 38, 1920, 944),
    );
    const primary = display("display:primary", frame(0, 0, 1512, 982), frame(0, 38, 1512, 944), true);
    const both = [secondaryLeft, primary];

    // The left display can only park further LEFT (away from the neighbor).
    expect(feasibleCorners(secondaryLeft, both, size, visibility)).toEqual([
      "bottomLeft",
      "topLeft",
    ]);
    // The primary can only park further RIGHT.
    expect(feasibleCorners(primary, both, size, visibility)).toEqual([
      "bottomRight",
      "topRight",
    ]);
  });

  test("a fully surrounded display has no feasible corners", () => {
    const center = display("display:c", frame(0, 0, 1000, 700), frame(0, 38, 1000, 662), true);
    const neighbors = [
      display("display:l", frame(-600, 0, 600, 700), frame(-600, 0, 600, 700)),
      display("display:r", frame(1000, 0, 600, 700), frame(1000, 0, 600, 700)),
      display("display:t", frame(-600, -800, 2200, 800), frame(-600, -800, 2200, 800)),
      display("display:b", frame(-600, 700, 2200, 800), frame(-600, 700, 2200, 800)),
    ];
    expect(feasibleCorners(center, [center, ...neighbors], size, visibility)).toEqual([]);
  });

  test("an alone display offers every corner in priority order", () => {
    expect(feasibleCorners(self, [self], size, visibility)).toEqual([...CORNER_PRIORITY]);
  });
});

// ---------------------------------------------------------------------------
// Fractional clamp rounding
// ---------------------------------------------------------------------------

describe("fractional clamp rounding toward the visible side", () => {
  // Pins roundLimitTowardVisible as implemented (parking.ts:206).
  // NOTE (discrepancy): with cornerTarget's formulas, LARGER visibility means
  // MORE visible window in ALL four corners, yet right/bottom limits floor
  // while left/top ceil. Documented behavior ("round toward visible side",
  // testing-guide) is pinned here as actually implemented — see task report.

  test("left corners round horizontal limits up (ceil)", () => {
    expect(roundLimitTowardVisible("bottomLeft", 2.2, "horizontal")).toBe(3);
    expect(roundLimitTowardVisible("topLeft", 2.8, "horizontal")).toBe(3);
  });

  test("right corners round horizontal limits down (floor)", () => {
    expect(roundLimitTowardVisible("bottomRight", 2.2, "horizontal")).toBe(2);
    expect(roundLimitTowardVisible("topRight", 2.8, "horizontal")).toBe(2);
  });

  test("top corners round vertical limits up (ceil)", () => {
    expect(roundLimitTowardVisible("topLeft", 4.7, "vertical")).toBe(5);
    expect(roundLimitTowardVisible("topRight", 4.2, "vertical")).toBe(5);
  });

  test("bottom corners round vertical limits down (floor)", () => {
    expect(roundLimitTowardVisible("bottomLeft", 51.3, "vertical")).toBe(51);
    expect(roundLimitTowardVisible("bottomRight", 51.7, "vertical")).toBe(51);
  });

  test("integral limits pass through unchanged on every corner/axis", () => {
    for (const corner of CORNER_PRIORITY) {
      expect(roundLimitTowardVisible(corner, 5, "horizontal")).toBe(5);
      expect(roundLimitTowardVisible(corner, 47, "vertical")).toBe(47);
    }
  });
});

// ---------------------------------------------------------------------------
// Search budget formula
// ---------------------------------------------------------------------------

describe("binary-search probe budget formula", () => {
  test("budget = 2·(⌈log2(max(2,maxDistance))⌉+3)+2", () => {
    expect(searchBudget(1)).toBe(10); // maxDistance floors at 2
    expect(searchBudget(2)).toBe(10); // 2·(1+3)+2
    expect(searchBudget(1024)).toBe(28); // 2·(10+3)+2
    expect(searchBudget(1025)).toBe(30); // ⌈log2 1025⌉ = 11
    expect(searchBudget(1512)).toBe(30);
  });

  test("budget is non-decreasing in distance", () => {
    let previous = searchBudget(2);
    for (let d = 3; d <= 4096; d *= 2) {
      const current = searchBudget(d);
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });
});

// ---------------------------------------------------------------------------
// Clamp discovery against the scripted OS
// ---------------------------------------------------------------------------

describe("clamp discovery (scripted OS)", () => {
  const SIZE: Size = { width: 320, height: 240 };

  test(`orthogonal-axis movement during the search is rejection evidence, not inconclusive (bean wm-ysdj)`, () => {
    // Same scenario twice: once with a clean OS, once with an OS whose
    // x-refusals ALSO drag the window along y (the macOS pathology from
    // bean wm-ysdj). The drifted probes must be classified as REJECTIONS —
    // keeping the measured limit at the true boundary — instead of derailing
    // discovery into an inconclusive failure.
    const d = display("display:br", frame(0, 0, 1000, 700), frame(0, 38, 1000, 662), true);
    const limits: ParkingVisibility = { horizontal: 3, vertical: 52 };
    const corner: ParkingCorner = "bottomRight"; // floor-rounding corner: exposes the drift effect
    // Seed ALREADY PARKED exactly at the corner so baseline probes align with
    // the held orthogonal coordinate (any offset would mask the drift).
    const parked = cornerTarget(d, corner, SIZE, limits);

    const clean = new ScriptedOs(d, corner, limits, [{ id: "window:seed", original: parked }]);
    const cleanResult = runDiscovery(clean, d, [d], corner, [makeCandidate(parked, "window:seed")]);
    expect(isDiscoverySuccess(cleanResult)).toBe(true);
    expect(clean.orthogonalDrifts).toBe(0);
    // With sub-point rejection thresholds the clean OS recovers the integer
    // limits exactly (no tolerance-band undershoot).
    if (isDiscoverySuccess(cleanResult)) {
      expect(cleanResult.visibility.horizontal).toBe(3);
      expect(cleanResult.visibility.vertical).toBe(52);
    }

    const drifty = new ScriptedOs(d, corner, limits, [{ id: "window:seed", original: parked }], {
      driftOnRefusedHorizontal: true,
    });
    const driftyResult = runDiscovery(drifty, d, [d], corner, [makeCandidate(parked, "window:seed")]);
    // NOT inconclusive: discovery still succeeds…
    expect(isDiscoverySuccess(driftyResult)).toBe(true);
    expect(drifty.orthogonalDrifts).toBeGreaterThanOrEqual(2);
    if (isDiscoverySuccess(driftyResult)) {
      // …and the orthogonal movement counted as REJECTION EVIDENCE: the
      // horizontal boundary stays pinned at the true limit (3) instead of
      // undershooting to 2.
      expect(driftyResult.visibility.horizontal).toBe(3);
      expect(Math.abs(driftyResult.visibility.vertical - 52)).toBeLessThanOrEqual(
        PARKING_ACCEPTANCE_PT,
      );
    }
  });

  test("binary-search budget respected and final combined point verified jointly exactly once", () => {
    const corner: ParkingCorner = "topLeft";
    const limits: ParkingVisibility = { horizontal: 3, vertical: 52 };
    const originalFrame = frame(-1100, -700, 320, 240); // on-screen inside NEG_DISPLAY
    const os = new ScriptedOs(NEG_DISPLAY, corner, limits, [
      { id: "window:seed", original: originalFrame },
    ]);
    const result = runDiscovery(os, NEG_DISPLAY, [NEG_DISPLAY], corner, [
      makeCandidate(originalFrame, "window:seed"),
    ]);

    expect(isDiscoverySuccess(result)).toBe(true);
    if (!isDiscoverySuccess(result)) return;
    // Ceil-rounding corners recover the integer limits exactly.
    expect(result.visibility).toEqual({ horizontal: 3, vertical: 52 });
    // Both axes searched within the documented budget…
    const budget = searchBudget(Math.max(NEG_DISPLAY.frame.width, NEG_DISPLAY.frame.height));
    expect(result.probesUsed).toBeGreaterThan(0);
    expect(result.probesUsed).toBeLessThanOrEqual(budget);
    // …writes = endpoint + probes + ONE joint verification + restore.
    const writes = os.writes.filter((w) => !w.failed);
    expect(writes.length).toBe(result.probesUsed + 3);

    const jointPoint = cornerTarget(NEG_DISPLAY, corner, SIZE, result.visibility);
    const jointWrites = writes.filter((w) => samePoint(w.point, jointPoint));
    expect(jointWrites.length).toBe(1);
    // The joint verification happens AFTER all single-axis probes and BEFORE
    // the restore write, which returns the seed to its original position.
    expect(samePoint(writes[writes.length - 1]!.point, originalFrame)).toBe(true);
    const jointIndex = writes.findIndex((w) => samePoint(w.point, jointPoint));
    for (let i = jointIndex + 1; i < writes.length; i++) {
      expect(samePoint(writes[i]!.point, originalFrame)).toBe(true);
    }
  });

  test("floor-rounded corner recovers integer limits end-to-end (bottom-right)", () => {
    const d = display("display:br2", frame(0, 0, 1000, 700), frame(0, 38, 1000, 662), true);
    const corner: ParkingCorner = "bottomRight";
    const limits: ParkingVisibility = { horizontal: 3, vertical: 52 };
    const originalFrame = frame(80, 118, 320, 240);
    const os = new ScriptedOs(d, corner, limits, [{ id: "window:seed", original: originalFrame }]);
    const result = runDiscovery(os, d, [d], corner, [makeCandidate(originalFrame, "window:seed")]);

    expect(isDiscoverySuccess(result)).toBe(true);
    if (!isDiscoverySuccess(result)) return;
    // Floor rounding admits a one-point undershoot within the documented
    // parking acceptance tolerance (domain-schema.md: acceptance 1 pt).
    expect([2, 3]).toContain(result.visibility.horizontal);
    expect([51, 52]).toContain(result.visibility.vertical);
    const budget = searchBudget(Math.max(d.frame.width, d.frame.height));
    expect(result.probesUsed).toBeLessThanOrEqual(budget);
    // The final joint write was honored by the emulated OS (safe sliver).
    const jointPoint = cornerTarget(d, corner, SIZE, result.visibility);
    const joint = os.writes.find((w) => !w.failed && samePoint(w.point, jointPoint));
    expect(joint).toBeDefined();
    expect(joint!.observed).toEqual(jointPoint);
  });

  test("candidate iteration continues after a dead first candidate (stale-probe starvation guard, beans wm-fh5i/wm-6aea)", () => {
    const corner: ParkingCorner = "topLeft";
    const limits: ParkingVisibility = { horizontal: 3, vertical: 52 };
    const deadFrame = frame(-1150, -750, 400, 300); // distinct size 400×300
    const liveFrame = frame(-1100, -700, 320, 240); // distinct size 320×240
    const os = new ScriptedOs(NEG_DISPLAY, corner, limits, [
      { id: "window:dead", original: deadFrame },
      { id: "window:live", original: liveFrame },
    ]);
    os.failAllWritesTo("window:dead");

    const result = runDiscovery(os, NEG_DISPLAY, [NEG_DISPLAY], corner, [
      makeCandidate(deadFrame, "window:dead"),
      makeCandidate(liveFrame, "window:live"),
    ]);

    // Iteration moved past the permanently-failing candidate instead of
    // starving, and succeeded using the SECOND candidate's geometry.
    expect(isDiscoverySuccess(result)).toBe(true);
    if (!isDiscoverySuccess(result)) return;
    expect(os.writes.some((w) => w.windowId === "window:dead" && w.failed)).toBe(true);
    const jointPoint = cornerTarget(NEG_DISPLAY, corner, { width: 320, height: 240 }, result.visibility);
    expect(os.writes.some((w) => w.windowId === "window:live" && samePoint(w.point, jointPoint))).toBe(
      true,
    );
    expect(os.writes.every((w) => w.windowId !== "window:live" || !w.failed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Discovery against the reference fake platform
// ---------------------------------------------------------------------------

describe("clamp discovery (reference fake platform)", () => {
  test("top-left discovery measures typical visibility, verifies jointly once, restores the seed", () => {
    const fake = createFakePlatform({
      clock: VIRTUAL_CLOCK,
      displays: [makeDisplay()],
      seed: 1337,
    });
    const seedId = fake.addWindow({ x: 100, y: 150 });
    const originalFrame = fake.frameOf(seedId)!;
    const displays = fake.displays();
    const d = displays[0]!;

    const result = Effect.runSync(
      discoverParkingLimits(
        { adapter: fake.adapter, clock: VIRTUAL_CLOCK },
        d,
        displays,
        "topLeft",
        [makeCandidate(originalFrame, seedId)],
      ),
    );

    expect(isDiscoverySuccess(result)).toBe(true);
    if (!isDiscoverySuccess(result)) return;
    // Fake refuses fully-offscreen writes by leaving ~1×52 pt visible; the
    // discovered fact matches the emulated sliver.
    expect(result.visibility).toEqual({ ...PARKING_TYPICAL_VISIBILITY });
    const budget = searchBudget(Math.max(d.frame.width, d.frame.height));
    expect(result.probesUsed).toBe(8); // endpoint 1 + horiz 3 + vert search 8 - shared accounting; pinned empirically
    expect(result.probesUsed).toBeLessThanOrEqual(budget);

    // Write accounting: endpoint + probes + ONE joint verification + restore.
    const records = fake.writes();
    expect(records.length).toBe(result.probesUsed + 3);
    const joint = cornerTarget(d, "topLeft", { width: 800, height: 600 }, result.visibility);
    expect(records.filter((w) => samePoint(w.requested, joint)).length).toBe(1);
    // First write is the fully-offscreen endpoint request…
    expect(records[0]!.requested).toEqual(
      cornerTarget(d, "topLeft", { width: 800, height: 600 }, { horizontal: 0, vertical: 0 }),
    );
    // …the last write restores the seed to its original position, verified by
    // readback within RESTORE_MATCH_THRESHOLD.
    expect(records[records.length - 1]!.requested).toEqual(originalFrame);
    expect(fake.frameOf(seedId)).toEqual(originalFrame);
  });

  test("default parking visibility mirrors the documented constants", () => {
    expect(defaultParkingVisibility()).toEqual(PARKING_TYPICAL_VISIBILITY);
    expect(defaultParkingVisibility().horizontal).toBe(1);
    expect(defaultParkingVisibility().vertical).toBe(52);
  });
});

// ---------------------------------------------------------------------------
// Parked-seed ordering & starvation guards
// ---------------------------------------------------------------------------

describe("probe candidate ordering (stale-probe starvation guards)", () => {
  const displays = [
    display("display:a", frame(0, 0, 1000, 700), frame(0, 38, 1000, 662), true),
  ];
  const onscreenA = makeCandidate(frame(50, 60, 300, 200), "window:on-a");
  const onscreenB = makeCandidate(frame(500, 100, 300, 200), "window:on-b");
  const offscreen = makeCandidate(frame(-5000, -5000, 300, 200), "window:off");
  const parkedOne = makeCandidate(frame(-999, 648, 300, 200), "window:parked-1");
  const parkedTwo = makeCandidate(frame(-999, 300, 300, 200), "window:parked-2");
  const minimized = { ...makeCandidate(frame(10, 10, 300, 200), "window:min"), minimized: true };
  const hidden = { ...makeCandidate(frame(20, 20, 300, 200), "window:hid"), hidden: true };

  test("minimized and hidden candidates are excluded entirely", () => {
    const ordered = orderProbeCandidates(
      [onscreenA, minimized, hidden, offscreen],
      new Set(),
      displays,
    );
    expect(ordered.map((w) => w.id)).toEqual(["window:off", "window:on-a"]);
  });

  test("off-display candidates precede on-screen candidates", () => {
    const ordered = orderProbeCandidates([onscreenA, onscreenB, offscreen], new Set(), displays);
    expect(ordered.map((w) => w.id)).toEqual(["window:off", "window:on-a", "window:on-b"]);
  });

  test("an already-parked candidate is never dropped or duplicated (no starvation)", () => {
    const ordered = orderProbeCandidates(
      [parkedOne, onscreenA, offscreen],
      new Set(["window:parked-1"]),
      displays,
    );
    const ids = ordered.map((w) => w.id);
    expect(ids).toContain("window:parked-1");
    expect(new Set(ids).size).toBe(ids.length);
    // Every surviving input appears exactly once.
    expect([...ids].sort()).toEqual(
      ["window:off", "window:on-a", "window:parked-1"].sort(),
    );
  });

  // DISCREPANCY: docs/rewrite/testing-guide.md says an already-parked
  // off-display candidate is the PREFERRED seed, but the implementation
  // rotates the FIRST parked seed to the END of the order (parking.ts:174).
  // These tests pin the actual ordering; see task report.
  test("single parked seed orders after the other candidates (actual behavior)", () => {
    const ordered = orderProbeCandidates(
      [parkedOne, onscreenA, offscreen],
      new Set(["window:parked-1"]),
      displays,
    );
    expect(ordered.map((w) => w.id)).toEqual([
      "window:off",
      "window:on-a",
      "window:parked-1",
    ]);
  });

  test("multiple parked seeds rotate the first to the end (actual behavior)", () => {
    const ordered = orderProbeCandidates(
      [parkedOne, parkedTwo, onscreenA],
      new Set(["window:parked-1", "window:parked-2"]),
      displays,
    );
    expect(ordered.map((w) => w.id)).toEqual([
      "window:parked-2",
      "window:on-a",
      "window:parked-1",
    ]);
  });

  test("intersectsAnyDisplay uses strict positive area (edge touch is off-display)", () => {
    const straddler = makeCandidate(frame(900, 100, 300, 200), "window:straddle");
    const edgeToucher = makeCandidate(frame(1000, 100, 300, 200), "window:touch");
    const outsider = makeCandidate(frame(-3000, 100, 300, 200), "window:out");
    expect(intersectsAnyDisplay(straddler, displays)).toBe(true);
    expect(intersectsAnyDisplay(edgeToucher, displays)).toBe(false);
    expect(intersectsAnyDisplay(outsider, displays)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Facts fingerprinting
// ---------------------------------------------------------------------------

describe("parking facts fingerprinting", () => {
  const BASE = display("display:x", frame(0, 0, 1512, 982), frame(0, 38, 1512, 944), true);

  const factFor = (d: DisplayObservation, corner: ParkingCorner): ParkingFact => ({
    displayId: d.id,
    corner,
    visibility: { horizontal: 1, vertical: 52 },
    fingerprint: displayParkingFingerprint(d),
  });

  test("fingerprint is deterministic for identical display-local geometry", () => {
    expect(displayParkingFingerprint(BASE)).toBe(displayParkingFingerprint({ ...BASE }));
  });

  test("neighbor connect/disconnect does NOT invalidate the fingerprint", () => {
    const fake = createFakePlatform({ clock: VIRTUAL_CLOCK, displays: [makeDisplay()] });
    const before = fake.displays()[0]!;
    const fpBefore = displayParkingFingerprint(before);

    fake.connectDisplay(
      makeDisplay({
        id: "display:neighbor",
        frame: frame(1512, 0, 1920, 1080),
        workArea: frame(1512, 38, 1920, 1042),
      }),
    );
    const withNeighbor = fake.displays()[0]!;
    expect(displayParkingFingerprint(withNeighbor)).toBe(fpBefore);

    fake.disconnectDisplay("display:neighbor");
    const after = fake.displays()[0]!;
    expect(displayParkingFingerprint(after)).toBe(fpBefore);

    // Facts recorded under the old topology still resolve.
    const fact = factFor(before, "bottomLeft");
    expect(findParkingFact([fact], after, "bottomLeft")).toEqual(fact);
  });

  test("own-geometry change DOES invalidate: facts stop resolving until re-measured", () => {
    const fake = createFakePlatform({ clock: VIRTUAL_CLOCK, displays: [makeDisplay()] });
    const before = fake.displays()[0]!;
    const fact = factFor(before, "bottomLeft");

    fake.updateWorkArea(before.id, frame(0, 40, 1512, 942));
    const after = fake.displays()[0]!;
    const fpAfter = displayParkingFingerprint(after);
    expect(fpAfter).not.toBe(fact.fingerprint);
    expect(findParkingFact([fact], after, "bottomLeft")).toBeNull();

    // Re-measured fact under the new fingerprint resolves again.
    const remeasured = { ...fact, fingerprint: fpAfter };
    expect(findParkingFact([remeasured], after, "bottomLeft")).toEqual(remeasured);
  });

  test("facts are keyed by display id AND corner; mismatched keys miss", () => {
    const other = display("display:y", frame(0, 0, 1512, 982), frame(0, 38, 1512, 944));
    const fact = factFor(BASE, "topRight");
    expect(findParkingFact([fact], BASE, "topRight")).toEqual(fact);
    expect(findParkingFact([fact], BASE, "bottomLeft")).toBeNull();
    expect(findParkingFact([fact], other, "topRight")).toBeNull();
  });

  test("withParkingFact replaces per display+corner and preserves other entries", () => {
    const keepOtherDisplay = factFor(display("display:z", frame(0, 0, 100, 100), frame(0, 0, 100, 100)), "topLeft");
    const oldSameKey = factFor(BASE, "bottomLeft");
    const otherCorner = factFor(BASE, "topLeft");
    const updated = { ...oldSameKey, visibility: { horizontal: 2, vertical: 40 } };

    const result = withParkingFact([keepOtherDisplay, oldSameKey, otherCorner], updated);
    expect(result).toHaveLength(3);
    expect(result.filter((f) => f === updated).length).toBe(1);
    expect(result.find((f) => f.displayId === BASE.id && f.corner === "bottomLeft")).toBe(updated);
    expect(result).toContainEqual(keepOtherDisplay);
    expect(result).toContainEqual(otherCorner);
  });

  test("OS version participates in the fingerprint", () => {
    expect(displayParkingFingerprint(BASE, "14.5")).toBe(displayParkingFingerprint(BASE, "14.5"));
    expect(displayParkingFingerprint(BASE, "14.5")).not.toBe(displayParkingFingerprint(BASE, "15.0"));
    expect(displayParkingFingerprint(BASE)).not.toBe(displayParkingFingerprint(BASE, "14.5"));
  });
});

// ---------------------------------------------------------------------------
// Probe restoration fallback chain
// ---------------------------------------------------------------------------

describe("probe restoration fallback chain", () => {
  const d = display("display:r", frame(0, 0, 1000, 700), frame(0, 38, 1000, 662), true);
  const corner: ParkingCorner = "topLeft";
  const limits: ParkingVisibility = { horizontal: 3, vertical: 52 };
  const workAreaCenter = {
    x: d.workArea.x + d.workArea.width / 2,
    y: d.workArea.y + d.workArea.height / 2,
  };

  test("failed original-position restore falls back to the work-area center anchor", () => {
    const originalFrame = frame(80, 118, 320, 240);
    const os = new ScriptedOs(d, corner, limits, [{ id: "window:seed", original: originalFrame }]);
    os.failNextWriteTo("window:seed", originalFrame); // first restore attempt fails

    const result = runDiscovery(os, d, [d], corner, [makeCandidate(originalFrame, "window:seed")]);
    expect(isDiscoverySuccess(result)).toBe(true);

    const tail = os.writes.slice(-2);
    expect(tail[0]!.failed).toBe(true);
    expect(samePoint(tail[0]!.point, originalFrame)).toBe(true);
    expect(tail[1]!.failed).toBe(false);
    expect(samePoint(tail[1]!.point, workAreaCenter)).toBe(true);
    const restored = os.frameOf("window:seed")!;
    expect(Math.abs(restored.x - workAreaCenter.x)).toBeLessThanOrEqual(RESTORE_MATCH_THRESHOLD);
    expect(Math.abs(restored.y - workAreaCenter.y)).toBeLessThanOrEqual(RESTORE_MATCH_THRESHOLD);
  });

  test("original → center → original: second original attempt still restores", () => {
    const originalFrame = frame(120, 140, 320, 240);
    const os = new ScriptedOs(d, corner, limits, [{ id: "window:seed", original: originalFrame }]);
    os.failNextWriteTo("window:seed", originalFrame); // first original attempt
    os.failNextWriteTo("window:seed", workAreaCenter); // center anchor attempt

    const result = runDiscovery(os, d, [d], corner, [makeCandidate(originalFrame, "window:seed")]);
    expect(isDiscoverySuccess(result)).toBe(true);

    const tail = os.writes.slice(-3);
    expect(tail.map((w) => w.failed)).toEqual([true, true, false]);
    expect(samePoint(tail[2]!.point, originalFrame)).toBe(true);
    expect(os.frameOf("window:seed")).toEqual(originalFrame);
  });
});

// ---------------------------------------------------------------------------
// Property: discovery equals exhaustive oracle over monotone integer boundaries
// ---------------------------------------------------------------------------

describe("property: discovery vs exhaustive oracle (seeded fast-check)", () => {
  test("measured limits match exhaustive probing of the OS boundary within the documented 1 pt acceptance tolerance", () => {
    const corner: ParkingCorner = "topLeft";
    const size: Size = { width: 320, height: 240 };
    const originalFrame = frame(-1150, -750, size.width, size.height); // inside NEG_DISPLAY
    const maxDim = Math.max(NEG_DISPLAY.frame.width, NEG_DISPLAY.frame.height);
    const budget = searchBudget(maxDim);

    const property = fc.property(
      fc.integer({ min: 2, max: 9 }),
      fc.integer({ min: 2, max: 70 }),
      (limitH, limitV) => {
        const limits: ParkingVisibility = { horizontal: limitH, vertical: limitV };
        const os = new ScriptedOs(NEG_DISPLAY, corner, limits, [
          { id: "window:seed", original: originalFrame },
        ]);
        const result = runDiscovery(os, NEG_DISPLAY, [NEG_DISPLAY], corner, [
          makeCandidate(originalFrame, "window:seed"),
        ]);
        if (!isDiscoverySuccess(result)) {
          throw new Error(`discovery failed for limits ${JSON.stringify(limits)}: ${JSON.stringify(result)}`);
        }

        // Exhaustive oracle: smallest integer visibility each axis grants,
        // derived from the emulated OS predicate itself.
        let oracleH = maxDim;
        let oracleV = maxDim;
        for (let v = 0; v <= maxDim; v++) {
          if (oracleH === maxDim && os.grantedAtVisibility(v, Number.MAX_SAFE_INTEGER)) oracleH = v;
          if (oracleV === maxDim && os.grantedAtVisibility(Number.MAX_SAFE_INTEGER, v)) oracleV = v;
          if (oracleH !== maxDim && oracleV !== maxDim) break;
        }

        // Acceptance band: probes within ±PARKING_ACCEPTANCE_PT of the true
        // boundary are honored by the OS, so the measured limit may land one
        // point below it — never above, never further below.
        expect(result.visibility.horizontal).toBeGreaterThanOrEqual(oracleH - PARKING_ACCEPTANCE_PT);
        expect(result.visibility.horizontal).toBeLessThanOrEqual(oracleH);
        expect(result.visibility.vertical).toBeGreaterThanOrEqual(oracleV - PARKING_ACCEPTANCE_PT);
        expect(result.visibility.vertical).toBeLessThanOrEqual(oracleV);
        expect(Number.isInteger(result.visibility.horizontal)).toBe(true);
        expect(Number.isInteger(result.visibility.vertical)).toBe(true);

        // Safety: the finally-verified combined point is honored by the OS.
        expect(os.grantedAtVisibility(result.visibility.horizontal, result.visibility.vertical)).toBe(
          true,
        );
        // Budget respected across both axes.
        expect(result.probesUsed).toBeLessThanOrEqual(budget);
      },
    );

    fc.assert(property, { numRuns: 96, seed: 20260823 });
  });
});
