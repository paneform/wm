import { Cause, Effect, Exit, Stream } from "effect";
import { describe, expect, test } from "vitest";
import { applyGeometryRequest } from "../src/geometry-service.ts";
import type { Clock, PlatformAdapter } from "../src/platform.ts";
import {
  type ExpectedWindowIdentity,
  type Frame,
  type WindowObservation,
  type WriteErrorKind,
  type WriteObservation,
} from "../src/schema.ts";

const INITIAL: Frame = { x: 10, y: 20, width: 300, height: 200 };
const TARGET: Frame = { x: 100, y: 120, width: 800, height: 600 };
const CLOCK: Clock = { now: () => 0, sleep: () => Effect.void };

const observation = (frame: Frame = INITIAL): WindowObservation => ({
  id: "window:1",
  pid: 4242,
  role: "AXWindow",
  frame,
  minimized: false,
  hidden: false,
  fullscreen: false,
  focused: true,
  capabilities: {
    movable: "supported",
    resizable: "supported",
    movableEvidence: "platform_report",
    resizableEvidence: "platform_report",
  },
});

const context = {
  constraints: {},
  initialFrame: INITIAL,
  workArea: { x: 0, y: 0, width: 2000, height: 1200 },
};

const writeResult = (
  requested: Frame,
  observed: Frame,
  errorKind?: WriteErrorKind,
): WriteObservation => {
  const result = {
    requested,
    observed,
    stable: errorKind === undefined,
  };
  return errorKind === undefined ? result : { ...result, errorKind };
};

function adapterWith(
  write: (
    part: "frame" | "position" | "size",
    expected: ExpectedWindowIdentity | undefined,
    current: WindowObservation,
  ) => WriteObservation,
  initial = INITIAL,
): PlatformAdapter {
  let current = observation(initial);
  return {
    events: Stream.empty,
    getTopology: () => Effect.succeed({ displays: [] }),
    getWindows: () => Effect.succeed([current]),
    getWindow: () => Effect.succeed(current),
    setWindowFrame: (_id, frame, expected) =>
      Effect.sync(() => {
        const result = write("frame", expected, current);
        if (result.errorKind === undefined) current = { ...current, frame: result.observed };
        return result;
      }),
    setWindowPosition: (_id, point, expected) =>
      Effect.sync(() => {
        const result = write("position", expected, current);
        if (result.errorKind === undefined) {
          current = { ...current, frame: result.observed };
        }
        return result;
      }),
    setWindowSize: (_id, size, expected) =>
      Effect.sync(() => {
        const result = write("size", expected, current);
        if (result.errorKind === undefined) {
          current = { ...current, frame: result.observed };
        }
        return result;
      }),
    focusWindow: () => Effect.succeed({ focused: true }),
  };
}

const run = (adapter: PlatformAdapter) =>
  Effect.runPromiseExit(
    applyGeometryRequest(
      { adapter, clock: CLOCK },
      { windowId: "window:1", frame: TARGET, attempts: 1 },
      context,
    ),
  );

const runPositionClamp = (adapter: PlatformAdapter, parking: boolean) =>
  Effect.runPromiseExit(
    applyGeometryRequest(
      { adapter, clock: CLOCK },
      parking
        ? {
            windowId: "window:1",
            frame: TARGET,
            attempts: 1,
            acceptance: "parkingStablePositionClamp",
          }
        : { windowId: "window:1", frame: TARGET, attempts: 2 },
      context,
    ),
  );

describe("geometry-service guarded writes", () => {
  test("accepts stable exact-size position drift only for parking requests", async () => {
    const clamped = { ...TARGET, x: TARGET.x + 12 };
    const makeAdapter = () => adapterWith(() => writeResult(TARGET, clamped));

    const parking = await runPositionClamp(makeAdapter(), true);
    expect(Exit.isSuccess(parking)).toBe(true);
    if (Exit.isSuccess(parking)) {
      expect(parking.value).toMatchObject({ outcome: "stableClamp", frame: clamped });
    }

    const ordinary = await runPositionClamp(makeAdapter(), false);
    expect(Exit.isFailure(ordinary)).toBe(true);
    if (Exit.isFailure(ordinary)) {
      const failure = Cause.failureOption(ordinary.cause);
      if (failure._tag === "Some") expect(failure.value.outcome).toBe("failed");
    }
  });

  test("one untouched attempt is rejected, while repeated guarded clamps are confirmed", async () => {
    const initial = { x: 1134, y: 32, width: 480, height: 950 };
    const target = { x: 1134, y: 32, width: 378, height: 950 };
    const makeAdapter = () => adapterWith(() => writeResult(target, initial), initial);
    const clampContext = {
      ...context,
      initialFrame: initial,
      workArea: { x: 0, y: 32, width: 1512, height: 950 },
    };
    const apply = (attempts: number) =>
      Effect.runPromiseExit(
        applyGeometryRequest(
          { adapter: makeAdapter(), clock: CLOCK },
          { windowId: "window:1", frame: target, attempts },
          clampContext,
        ),
      );

    const untouched = await apply(1);
    expect(Exit.isFailure(untouched)).toBe(true);
    if (Exit.isFailure(untouched)) {
      const failure = Cause.failureOption(untouched.cause);
      if (failure._tag === "Some") expect(failure.value.outcome).toBe("failed");
    }

    const repeated = await apply(3);
    expect(Exit.isSuccess(repeated)).toBe(true);
    if (Exit.isSuccess(repeated)) {
      expect(repeated.value).toMatchObject({
        outcome: "stableClamp",
        frame: initial,
        attemptsUsed: 3,
        learningConfirmed: true,
        learning: {
          candidates: [{ axis: "width", direction: "min", value: 480 }],
          skipped: [],
        },
      });
    }
  });

  test("uses one compound primary write with the canonical expected identity", async () => {
    const seen: Array<{ part: string; expected: ExpectedWindowIdentity | undefined }> = [];
    const adapter = adapterWith((part, expected, current) => {
      seen.push({ part, expected });
      const observed = part === "frame" ? TARGET : current.frame;
      return writeResult(TARGET, observed);
    });

    const exit = await run(adapter);
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(seen).toEqual([{ part: "frame", expected: { fingerprint: '[4242,"AXWindow",null]' } }]);
  });

  test("compound primary succeeds where independent component writes reanchor each other", async () => {
    let frame = INITIAL;
    let compoundWrites = 0;
    let componentWrites = 0;
    const expectedIdentity = { fingerprint: '[4242,"AXWindow",null]' };
    const adapter: PlatformAdapter = {
      events: Stream.empty,
      getTopology: () => Effect.succeed({ displays: [] }),
      getWindows: () => Effect.succeed([observation(frame)]),
      getWindow: () => Effect.succeed(observation(frame)),
      setWindowFrame: (_id, requested, expected) =>
        Effect.sync(() => {
          expect(expected).toEqual(expectedIdentity);
          compoundWrites += 1;
          frame = requested;
          return writeResult(requested, frame);
        }),
      setWindowPosition: (_id, point, expected) =>
        Effect.sync(() => {
          expect(expected).toEqual(expectedIdentity);
          componentWrites += 1;
          frame = { ...frame, ...point, width: INITIAL.width, height: INITIAL.height };
          return writeResult({ ...frame, ...point }, frame);
        }),
      setWindowSize: (_id, size, expected) =>
        Effect.sync(() => {
          expect(expected).toEqual(expectedIdentity);
          componentWrites += 1;
          frame = { ...frame, x: INITIAL.x, y: INITIAL.y, ...size };
          return writeResult({ ...frame, ...size }, frame);
        }),
      focusWindow: () => Effect.succeed({ focused: true }),
    };

    const exit = await run(adapter);
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.outcome).toBe("exact");
    expect(frame).toEqual(TARGET);
    expect(compoundWrites).toBe(1);
    expect(componentWrites).toBe(0);

    // The former independent position→size sequence cannot retain both components.
    await Effect.runPromise(adapter.setWindowPosition("window:1", TARGET, expectedIdentity));
    await Effect.runPromise(
      adapter.setWindowSize(
        "window:1",
        { width: TARGET.width, height: TARGET.height },
        expectedIdentity,
      ),
    );
    expect(frame).not.toEqual(TARGET);
  });

  test.each([
    ["stale", "stale"],
    ["rejected", "rejected"],
    ["not_controllable", "rejected"],
  ] as const)("maps observation errorKind %s to %s", async (errorKind, code) => {
    const exit = await run(
      adapterWith((_part, _expected, current) => writeResult(TARGET, current.frame, errorKind)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") expect(failure.value.code).toBe(code);
    }
  });

  test("identity mismatch reports stale without mutating the replacement", async () => {
    let mutations = 0;
    const replacementFrame = { ...INITIAL, x: 777 };
    const adapter = adapterWith((_part, expected) => {
      expect(expected).toEqual({ fingerprint: '[4242,"AXWindow",null]' });
      return writeResult(TARGET, replacementFrame, "stale");
    });
    const guarded: PlatformAdapter = {
      ...adapter,
      setWindowPosition: (id, point, expected) =>
        Effect.flatMap(adapter.setWindowPosition(id, point, expected), (result) => {
          if (result.errorKind === undefined) mutations += 1;
          return Effect.succeed(result);
        }),
    };

    const exit = await run(guarded);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(mutations).toBe(0);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      if (failure._tag === "Some") {
        expect(failure.value).toMatchObject({ code: "stale", observed: replacementFrame });
      }
    }
  });
});
