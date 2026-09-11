import { Effect, Stream } from "effect";
import { describe, expect, test } from "vitest";
import { createEngine } from "../src/engine.ts";
import {
  inferInitialTree,
  resolveInitialLayout,
  type EngineInitialLayout,
} from "../src/initial-layout.ts";
import { planLayout } from "../src/layout/bsp.ts";
import type { Clock, ConfigSource, PlatformAdapter } from "../src/platform.ts";
import type { PlatformEvent } from "../src/schema.ts";
import { createFakePlatform, makeDisplay, makeWindow } from "./helpers/fake-platform.ts";

const CLOCK: Clock = {
  now: () => 0,
  sleep: () => Effect.void,
};

const PRIMARY = makeDisplay();
const LEFT = makeDisplay({
  id: "display:left",
  frame: { x: -1200, y: -200, width: 1200, height: 900 },
  workArea: { x: -1200, y: -160, width: 1200, height: 860 },
  primary: false,
});

const CONFIG: ConfigSource = {
  load: () =>
    Effect.succeed({
      defaults: { gap: 19 },
      workspaces: [
        { name: "code", preferredDisplay: PRIMARY.id },
        { name: "declared-only", preferredDisplay: LEFT.id },
      ],
    }),
  changes: () => Stream.empty,
};

describe("initial layout hydration", () => {
  test("recovers the 40/60 width and right-hand 70/30 height splits regardless of inventory order", () => {
    const a = { id: "A", frame: { x: -1000, y: 40, width: 400, height: 800 } };
    const b = { id: "B", frame: { x: -600, y: 40, width: 600, height: 560 } };
    const c = { id: "C", frame: { x: -600, y: 600, width: 600, height: 240 } };
    const original = structuredClone([a, b, c]);
    for (const windows of [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ]) {
      const tree = inferInitialTree(windows)!;
      expect(tree).toEqual({
        kind: "split",
        axis: "vertical",
        ratio: 0.4,
        first: { kind: "leaf", windowId: "A" },
        second: {
          kind: "split",
          axis: "horizontal",
          ratio: 0.7,
          first: { kind: "leaf", windowId: "B" },
          second: { kind: "leaf", windowId: "C" },
        },
      });
      const plan = planLayout({
        tree,
        content: { x: -1000, y: 40, width: 1000, height: 800 },
        gap: 0,
        resolve: () => undefined,
      });
      expect(plan.feasible && Object.fromEntries(plan.frames)).toEqual(
        Object.fromEntries(original.map(({ id, frame }) => [id, frame])),
      );
    }
    expect([a, b, c]).toEqual(original);
  });

  test("already-correct gaps and padding are preserved exactly", () => {
    const content = { x: 20, y: 20, width: 960, height: 760 };
    const windows = [
      { id: "A", frame: { x: 20, y: 20, width: 372, height: 760 } },
      { id: "B", frame: { x: 408, y: 20, width: 572, height: 532 } },
      { id: "C", frame: { x: 408, y: 568, width: 572, height: 212 } },
    ];
    const tree = inferInitialTree(windows, content, 16)!;
    const plan = planLayout({ tree, content, gap: 16, resolve: () => undefined });
    expect(plan.feasible && Object.fromEntries(plan.frames)).toEqual(
      Object.fromEntries(windows.map(({ id, frame }) => [id, frame])),
    );
  });

  test.each([
    [37, 90],
    [15, 22],
    [115, 900],
  ])("round-trips a %s-pixel divider in %s usable points", (first, space) => {
    const content = { x: -17, y: 23, width: space + 11, height: 79 };
    const windows = [
      { id: "A", frame: { x: -17, y: 23, width: first, height: 79 } },
      { id: "B", frame: { x: first - 6, y: 23, width: space - first, height: 79 } },
    ];

    const tree = inferInitialTree(windows, content, 11)!;
    const plan = planLayout({ tree, content, gap: 11, resolve: () => undefined });

    expect(tree).toMatchObject({ kind: "split", axis: "vertical" });
    expect(plan.feasible && Object.fromEntries(plan.frames)).toEqual(
      Object.fromEntries(windows.map(({ id, frame }) => [id, frame])),
    );
  });

  test("splits overlap fallback across half of usable space", () => {
    const tree = inferInitialTree(
      [
        { id: "A", frame: { x: 0, y: 0, width: 70, height: 80 } },
        { id: "B", frame: { x: 30, y: 0, width: 70, height: 80 } },
      ],
      { x: 0, y: 0, width: 101, height: 80 },
      11,
    )!;
    const plan = planLayout({
      tree,
      content: { x: 0, y: 0, width: 101, height: 80 },
      gap: 11,
      resolve: () => undefined,
    });

    expect(tree).toMatchObject({ kind: "split", axis: "vertical", ratio: 0.5 });
    expect(plan.feasible && plan.frames.get("A")).toEqual({ x: 0, y: 0, width: 45, height: 80 });
    expect(plan.feasible && plan.frames.get("B")).toEqual({ x: 56, y: 0, width: 45, height: 80 });
  });

  test("transfers an affine layout to a disjoint display without collapsing its first pane", () => {
    const windows = [
      { id: "A", frame: { x: 0, y: 0, width: 400, height: 800 } },
      { id: "B", frame: { x: 400, y: 0, width: 600, height: 800 } },
    ];
    expect(inferInitialTree(windows, { x: 2000, y: 0, width: 2000, height: 800 })).toMatchObject({
      axis: "vertical",
      ratio: 0.4,
    });
  });

  test("infers clean split ratios and uses a balanced overlap fallback", () => {
    const layout: EngineInitialLayout = {
      windows: [
        { windowId: "left", workspace: "code" },
        { windowId: "right", workspace: "code" },
      ],
      displays: [],
      focusedWorkspace: "code",
    };
    const clean = resolveInitialLayout(
      layout,
      new Map([
        ["left", { x: 0, y: 0, width: 600, height: 800 }],
        ["right", { x: 600, y: 0, width: 400, height: 800 }],
      ]),
      new Set(),
    )[0]?.tree;
    const overlap = resolveInitialLayout(
      layout,
      new Map([
        ["left", { x: 0, y: 0, width: 700, height: 800 }],
        ["right", { x: 300, y: 0, width: 700, height: 800 }],
      ]),
      new Set(),
    )[0]?.tree;

    expect(clean).toMatchObject({ kind: "split", axis: "vertical", ratio: 0.6 });
    expect(overlap).toMatchObject({ kind: "split", axis: "vertical", ratio: 0.5 });
  });

  test("preserves the observed scene without writes or invented workspaces", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [PRIMARY, LEFT] });
    const overlap = { x: 30, y: 50, width: 900, height: 700 };
    const first = fake.addWindow(makeWindow({ id: "window:first", ...overlap }));
    const second = fake.addWindow(makeWindow({ id: "window:second", ...overlap }));
    const outside = fake.addWindow(
      makeWindow({ id: "window:outside", x: 4000, y: -3000, width: 2200, height: 1400 }),
    );
    const unassigned = fake.addWindow(
      makeWindow({ id: "window:unassigned", x: -1800, y: 1200, width: 500, height: 300 }),
    );
    fake.focusWindowExternal(second);

    const initialLayout: EngineInitialLayout = {
      windows: [
        { windowId: first, workspace: "code" },
        { windowId: second, workspace: "code", floating: true },
        { windowId: outside, workspace: "away" },
        { windowId: unassigned, workspace: null },
      ],
      displays: [
        { displayId: PRIMARY.id, workspace: "code" },
        { displayId: LEFT.id, workspace: null },
      ],
      focusedWorkspace: "code",
    };
    const engine = await Effect.runPromise(
      createEngine({ adapter: fake.adapter, configSource: CONFIG, clock: CLOCK, initialLayout }),
    );
    await Effect.runPromise(engine.start());
    const state = await Effect.runPromise(engine.state());

    expect(fake.writes()).toEqual([]);
    expect(state.windows.map(({ id, frame }) => ({ id, frame }))).toEqual([
      { id: first, frame: overlap },
      { id: second, frame: overlap },
      { id: outside, frame: { x: 4000, y: -3000, width: 2200, height: 1400 } },
      { id: unassigned, frame: { x: -1800, y: 1200, width: 500, height: 300 } },
    ]);
    expect(state.windows.find((window) => window.id === unassigned)?.workspace).toBeNull();
    expect(state.workspaces.map((workspace) => workspace.name)).toEqual(["code", "away"]);
    expect(state.workspaces.find((workspace) => workspace.name === "code")).toMatchObject({
      members: [first],
      floating: [second],
      visibleOnDisplay: PRIMARY.id,
      preferredDisplay: PRIMARY.id,
      lastFocusedMember: second,
    });
    expect(
      state.workspaces.find((workspace) => workspace.name === "away")?.visibleOnDisplay,
    ).toBeNull();
    expect(state.focusedWorkspace).toBe("code");
    expect(state.focusedWindow).toBe(second);
  });

  test("ignores buffered platform hints while importing the first snapshot", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [PRIMARY] });
    const windowId = fake.addWindow(
      makeWindow({ id: "window:buffered", x: 80, y: 90, width: 420, height: 310 }),
    );
    const bufferedEvent: PlatformEvent = { kind: "wake" };
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      events: Stream.make(bufferedEvent),
    };
    const engine = await Effect.runPromise(
      createEngine({
        adapter,
        configSource: CONFIG,
        clock: CLOCK,
        initialLayout: {
          windows: [{ windowId, workspace: "code" }],
          displays: [{ displayId: PRIMARY.id, workspace: "code" }],
          focusedWorkspace: "code",
        },
      }),
    );

    await Effect.runPromise(engine.start());
    expect(fake.writes()).toEqual([]);
    expect((await Effect.runPromise(engine.state())).windows[0]?.frame).toEqual({
      x: 80,
      y: 90,
      width: 420,
      height: 310,
    });
  });

  test("does not install listeners when initial reference validation fails", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [PRIMARY] });
    let subscriptions = 0;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      events: Stream.unwrap(
        Effect.sync(() => {
          subscriptions += 1;
          return Stream.never;
        }),
      ),
    };
    const engine = await Effect.runPromise(
      createEngine({
        adapter,
        configSource: CONFIG,
        clock: CLOCK,
        initialLayout: {
          windows: [{ windowId: "window:missing", workspace: "code" }],
          displays: [{ displayId: PRIMARY.id, workspace: "code" }],
          focusedWorkspace: "code",
        },
      }),
    );

    await expect(Effect.runPromise(engine.start())).rejects.toThrow();
    expect(subscriptions).toBe(0);
  });

  test("accepts a full-zero inventory after explicit removal hints", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [PRIMARY] });
    const first = fake.addWindow(makeWindow({ id: "window:remove-first" }));
    const second = fake.addWindow(makeWindow({ id: "window:remove-second" }));
    const engine = await Effect.runPromise(
      createEngine({
        adapter: fake.adapter,
        configSource: CONFIG,
        clock: CLOCK,
        initialLayout: {
          windows: [
            { windowId: first, workspace: "code", floating: true },
            { windowId: second, workspace: "code", floating: true },
          ],
          displays: [{ displayId: PRIMARY.id, workspace: "code" }],
          focusedWorkspace: "code",
        },
      }),
    );
    await Effect.runPromise(engine.start());

    fake.removeWindow(first);
    fake.removeWindow(second);
    await waitFor(async () => (await Effect.runPromise(engine.state())).windows.length === 0);
    const state = await Effect.runPromise(engine.state());
    expect(state.windows).toEqual([]);
    expect(state.focusedWindow).toBeUndefined();
  });

  test("retains committed windows for an eventless transient zero inventory", async () => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [PRIMARY] });
    const windowId = fake.addWindow(makeWindow({ id: "window:transient-zero" }));
    let reportEmpty = false;
    const adapter: PlatformAdapter = {
      ...fake.adapter,
      getWindows: () => (reportEmpty ? Effect.succeed([]) : fake.adapter.getWindows()),
    };
    const engine = await Effect.runPromise(
      createEngine({
        adapter,
        configSource: CONFIG,
        clock: CLOCK,
        initialLayout: {
          windows: [{ windowId, workspace: "code", floating: true }],
          displays: [{ displayId: PRIMARY.id, workspace: "code" }],
          focusedWorkspace: "code",
        },
      }),
    );
    await Effect.runPromise(engine.start());

    reportEmpty = true;
    await Effect.runPromise(engine.reconcile());
    expect((await Effect.runPromise(engine.state())).windows.map((window) => window.id)).toEqual([
      windowId,
    ]);
  });

  test.each<{ name: string; layout: EngineInitialLayout }>([
    {
      name: "unknown window",
      layout: {
        windows: [{ windowId: "missing", workspace: "one" }],
        displays: [],
        focusedWorkspace: "one",
      },
    },
    {
      name: "duplicate membership",
      layout: {
        windows: [
          { windowId: "window:known", workspace: "one" },
          { windowId: "window:known", workspace: "two" },
        ],
        displays: [],
        focusedWorkspace: "one",
      },
    },
    {
      name: "duplicate display assignment",
      layout: {
        windows: [{ windowId: "window:known", workspace: "one" }],
        displays: [
          { displayId: PRIMARY.id, workspace: "one" },
          { displayId: LEFT.id, workspace: "one" },
        ],
        focusedWorkspace: "one",
      },
    },
    {
      name: "unknown display",
      layout: {
        windows: [{ windowId: "window:known", workspace: "one" }],
        displays: [{ displayId: "display:missing", workspace: "one" }],
        focusedWorkspace: "one",
      },
    },
    {
      name: "duplicate display reference",
      layout: {
        windows: [{ windowId: "window:known", workspace: "one" }],
        displays: [
          { displayId: PRIMARY.id, workspace: "one" },
          { displayId: PRIMARY.id, workspace: null },
        ],
        focusedWorkspace: "one",
      },
    },
  ])("rejects $name", async ({ layout }) => {
    const fake = createFakePlatform({ clock: CLOCK, displays: [PRIMARY, LEFT] });
    fake.addWindow(makeWindow({ id: "window:known" }));
    const engine = await Effect.runPromise(
      createEngine({
        adapter: fake.adapter,
        configSource: CONFIG,
        clock: CLOCK,
        initialLayout: layout,
      }),
    );
    await expect(Effect.runPromise(engine.start())).rejects.toThrow();
    expect(fake.writes()).toEqual([]);
  });
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
