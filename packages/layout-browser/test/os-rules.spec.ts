import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { DisplayObservation, Frame } from "@paneform/layout";
import { createMacOsRules } from "../src/sim/macos-rules.js";
import type { OsGeometryRequest, OsRuleset } from "../src/sim/os-rules.js";
import { unconstrainedOsRules } from "../src/sim/os-rules.js";
import { createWebPlatformSim } from "../src/sim/web-platform.js";

const native: DisplayObservation = {
  id: "native",
  frame: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 32, width: 1512, height: 950 },
  scale: 2,
  primary: true,
};
const sidecar: DisplayObservation = {
  id: "sidecar",
  frame: { x: 1512, y: 0, width: 1302, height: 1024 },
  workArea: { x: 1512, y: 0, width: 1302, height: 1024 },
  scale: 2,
  primary: false,
};

const apply = (
  requested: Frame,
  displays: readonly DisplayObservation[] = [native, sidecar],
  rules = createMacOsRules(),
) => rules.applyGeometry({ previous: requested, requested, displays, operation: "external" });

const readFrame = async (sim: ReturnType<typeof createWebPlatformSim>, id: string) =>
  (await Effect.runPromise(sim.adapter.getWindow(id)))!.frame;

describe("macOS rules", () => {
  it.each([
    ["native menu bar", { x: 100, y: 0, width: 500, height: 300 }, { x: 100, y: 32 }],
    ["sidecar top edge", { x: 1700, y: -20, width: 500, height: 300 }, { x: 1700, y: 0 }],
    ["one point at the left", { x: -499, y: 100, width: 500, height: 300 }, { x: -499, y: 100 }],
    ["one point at the right", { x: 2813, y: 100, width: 500, height: 300 }, { x: 2813, y: 100 }],
    ["zero points at the left", { x: -500, y: 100, width: 500, height: 300 }, { x: -460, y: 100 }],
    ["zero points at the right", { x: 2814, y: 100, width: 500, height: 300 }, { x: 2774, y: 100 }],
    ["bottom edge", { x: 100, y: 982, width: 500, height: 300 }, { x: 100, y: 930 }],
  ] as const)("constrains the %s", (_name, requested, expected) => {
    expect(apply(requested)).toMatchObject(expected);
  });

  it("supports configurable visibility distances", () => {
    const rules = createMacOsRules({ horizontalFallback: 64, bottomVisible: 64 });
    expect(apply({ x: -500, y: 982, width: 500, height: 300 }, [native], rules)).toEqual({
      x: -436,
      y: 918,
      width: 500,
      height: 300,
    });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 10_001])(
    "rejects an invalid visibility distance of %s",
    (value) => expect(() => createMacOsRules({ horizontalFallback: value })).toThrow(RangeError),
  );

  it("handles tiny and oversized windows", () => {
    expect(apply({ x: -20, y: 1000, width: 20, height: 10 }, [native])).toEqual({
      x: 0,
      y: 972,
      width: 20,
      height: 10,
    });
    expect(apply({ x: -2000, y: -100, width: 2000, height: 2000 }, [native])).toEqual({
      x: -1960,
      y: 32,
      width: 2000,
      height: 2000,
    });
  });

  it("leaves geometry unchanged when there are no displays", () => {
    const requested = { x: -900, y: -700, width: 400, height: 300 };
    expect(apply(requested, [])).toEqual(requested);
    expect(apply(requested, [])).not.toBe(requested);
  });

  it("selects displays across negative origins and gaps", () => {
    const left = {
      ...sidecar,
      id: "left",
      frame: { ...sidecar.frame, x: -1302 },
      workArea: { ...sidecar.workArea, x: -1302 },
    };
    expect(apply({ x: -1802, y: -20, width: 500, height: 300 }, [native, left])).toMatchObject({
      x: -1762,
      y: 0,
    });
    expect(
      apply({ x: 1540, y: -20, width: 20, height: 300 }, [
        native,
        {
          ...sidecar,
          frame: { ...sidecar.frame, x: 1600 },
          workArea: { ...sidecar.workArea, x: 1600 },
        },
      ]),
    ).toMatchObject({
      x: 1492,
      y: 32,
    });
  });

  it("is idempotent", () => {
    const once = apply({ x: 3000, y: 2000, width: 500, height: 300 });
    expect(apply(once)).toEqual(once);
  });

  it("keeps corrected frames stable across staggered displays", () => {
    const displays = [
      {
        ...native,
        frame: { x: 0, y: 0, width: 1000, height: 1000 },
        workArea: { x: 0, y: 32, width: 1000, height: 968 },
      },
      {
        ...sidecar,
        frame: { x: 1000, y: 500, width: 1000, height: 1000 },
        workArea: { x: 1000, y: 532, width: 1000, height: 968 },
      },
    ];
    const corrected = apply({ x: 800, y: -500, width: 1000, height: 700 }, displays);
    expect(corrected.y).toBe(32);
    expect(apply(corrected, displays)).toEqual(corrected);
  });
});

describe("web platform OS-rules integration", () => {
  it.each(["animated", "slowAnimated"] as const)(
    "composes %s frame components before settling",
    async (kind) => {
      const sim = createWebPlatformSim({ displays: [native], osRules: createMacOsRules() });
      const id = sim.addWindow({ x: 100, y: 100, width: 300, height: 200, personality: { kind } });
      const requested = { x: 400, y: -20, width: 500, height: 400 };
      await Effect.runPromise(sim.adapter.setWindowFrame(id, requested));
      for (let read = 0; read < 100; read++) await readFrame(sim, id);
      expect(await readFrame(sim, id)).toEqual({ ...requested, y: 32 });
    },
  );
  it("injects complete requests into all adapter geometry calls", async () => {
    const calls: OsGeometryRequest[] = [];
    const rules: OsRuleset = {
      name: "recording",
      applyGeometry(request) {
        calls.push(request);
        return { ...request.requested, y: request.requested.y + 7 };
      },
    };
    const sim = createWebPlatformSim({ displays: [native], osRules: rules });
    const id = sim.addWindow({ x: 10, y: 20, width: 300, height: 200 });

    await Effect.runPromise(sim.adapter.setWindowPosition(id, { x: 40, y: 50 }));
    await Effect.runPromise(sim.adapter.setWindowSize(id, { width: 350, height: 250 }));
    await Effect.runPromise(
      sim.adapter.setWindowFrame(id, { x: 70, y: 80, width: 400, height: 300 }),
    );

    expect(rules.name).toBe("recording");
    expect(calls.map(({ operation }) => operation)).toEqual([
      "position",
      "size",
      "size",
      "position",
      "size",
    ]);
    expect(calls[0]).toMatchObject({
      previous: { x: 10, y: 20, width: 300, height: 200 },
      requested: { x: 40, y: 50, width: 300, height: 200 },
      displays: [native],
    });
    expect(await readFrame(sim, id)).toEqual({ x: 70, y: 94, width: 400, height: 300 });
  });

  it("applies returned external frames for drift, nudge, and update", async () => {
    const requests: OsGeometryRequest[] = [];
    const sim = createWebPlatformSim({
      displays: [native],
      osRules: {
        name: "external",
        applyGeometry: (request) => {
          requests.push(request);
          return { ...request.requested, x: 777 };
        },
      },
    });
    const id = sim.addWindow({ x: 10, y: 20, width: 300, height: 200 });

    sim.driftWindow(id, 5, 6);
    expect(await readFrame(sim, id)).toEqual({ x: 777, y: 26, width: 300, height: 200 });
    sim.nudgeWindow(id, { y: 90, width: 320 });
    expect(await readFrame(sim, id)).toEqual({ x: 777, y: 90, width: 320, height: 200 });
    sim.updateWindow(id, { frame: { x: 1, y: 2, width: 3, height: 4 } });
    expect(await readFrame(sim, id)).toEqual({ x: 777, y: 2, width: 3, height: 4 });
    expect(requests.map(({ operation }) => operation)).toEqual([
      "external",
      "external",
      "external",
    ]);
  });

  it("keeps adapter personality bounds with unconstrained OS rules", async () => {
    const sim = createWebPlatformSim({ displays: [native], osRules: unconstrainedOsRules });
    const id = sim.addWindow({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      personality: { kind: "minMaxClamp", constraints: { minWidth: 250, maxHeight: 400 } },
    });
    await Effect.runPromise(sim.adapter.setWindowSize(id, { width: 100, height: 500 }));
    expect(await readFrame(sim, id)).toEqual({ x: 10, y: 20, width: 250, height: 400 });
  });

  it("imports an added window exactly without applying OS rules", async () => {
    let calls = 0;
    const sim = createWebPlatformSim({
      displays: [native],
      osRules: { name: "counting", applyGeometry: ({ requested }) => (calls++, requested) },
    });
    const frame = { x: -900, y: -700, width: 400, height: 300 };
    const id = sim.addWindow(frame);
    expect(await readFrame(sim, id)).toEqual(frame);
    expect(calls).toBe(0);
  });

  it("clears an animated write target after an external mutation", async () => {
    const sim = createWebPlatformSim({ displays: [native], osRules: unconstrainedOsRules });
    const id = sim.addWindow({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
      personality: { kind: "slowAnimated" },
    });
    await Effect.runPromise(sim.adapter.setWindowPosition(id, { x: 1000, y: 700 }));
    sim.nudgeWindow(id, { x: 123, y: 234 });
    for (let index = 0; index < 50; index += 1) await readFrame(sim, id);
    expect(await readFrame(sim, id)).toEqual({ x: 123, y: 234, width: 300, height: 200 });
  });
});
