import { Effect, Stream } from "effect";
import { expect, test } from "vitest";
import { createEngine } from "../src/engine.ts";
import type { Clock, ConfigSource } from "../src/platform.ts";
import { PlatformError, type WindowInventory } from "../src/schema.ts";
import { createFakePlatform, makeDisplay, makeWindow } from "./helpers/fake-platform.ts";

const configSource: ConfigSource = {
  load: () => Effect.succeed({ workspaces: [{ name: "3", assign: [{ bundleId: "cad" }] }] }),
  changes: () => Stream.empty,
};

const setup = async (nativeEvents = false, initialUnavailableReads = 0) => {
  let now = 0;
  let unavailable = false;
  let absent = false;
  let closed = false;
  const clock: Clock = { now: () => now, sleep: (ms) => (ms >= 5000 ? Effect.never : Effect.void) };
  const display = makeDisplay();
  const fake = createFakePlatform({ clock, displays: [display] });
  fake.addWindow(makeWindow({ id: "visible", pid: 1 }));
  fake.addWindow(makeWindow({ id: "cad", pid: 2, bundleId: "cad", instanceId: "original" }));
  fake.addWindow(makeWindow({ id: "peer", pid: 3 }));
  const getWindowInventory = () =>
    unavailable || initialUnavailableReads-- > 0
      ? Effect.fail(new PlatformError({ code: "unavailable" }))
      : Effect.map(fake.adapter.getWindows(), (windows): WindowInventory => ({
          windows: windows.filter((window) => !absent || window.id !== "cad"),
          unavailableWindowIds: absent && !closed ? ["cad"] : [],
          closedWindowIds: closed ? ["cad"] : [],
        }));
  const engine = await Effect.runPromise(
    createEngine({
      adapter: {
        ...fake.adapter,
        events: nativeEvents ? fake.adapter.events : Stream.empty,
        getWindowInventory,
      },
      configSource,
      clock,
      initialLayout: {
        windows: [
          { windowId: "visible", workspace: "C" },
          { windowId: "cad", workspace: "home" },
          { windowId: "peer", workspace: "3" },
        ],
        displays: [{ displayId: display.id, workspace: "C" }],
        focusedWorkspace: "C",
      },
    }),
  );
  await Effect.runPromise(engine.start());
  const reconcile = () => Effect.runPromise(engine.reconcile());
  const state = () => Effect.runPromise(engine.state());
  return {
    engine,
    fake,
    reconcile,
    state,
    elapse: (ms: number) => {
      now += ms;
    },
    absent: (value: boolean) => {
      absent = value;
    },
    unavailable: (value: boolean) => {
      unavailable = value;
    },
    closed: (value: boolean) => {
      closed = value;
    },
  };
};

const home = async (h: Awaited<ReturnType<typeof setup>>, id = "cad") =>
  (await h.state()).workspaces.find(
    (workspace) => workspace.members.includes(id) || workspace.floating.includes(id),
  )?.name;

test("startup waits for usable inventory rather than treating initial unavailability as empty", async () => {
  const h = await setup(false, 2);
  try {
    expect(await home(h)).toBe("home");
  } finally {
    await Effect.runPromise(h.engine.stop());
  }
});

test("returning instance keeps manual assignment after days, ahead of config", async () => {
  const h = await setup();
  try {
    h.absent(true);
    const writes = h.fake.writes().length;
    await h.reconcile();
    expect(
      h.fake
        .writes()
        .slice(writes)
        .some((write) => write.windowId === "cad"),
    ).toBe(false);
    expect((await h.state()).windows.some((window) => window.id === "cad")).toBe(false);
    h.elapse(7 * 24 * 60 * 60 * 1000);
    h.absent(false);
    await h.reconcile();
    expect(await home(h)).toBe("home");
    expect((await h.state()).focusedWorkspace).toBe("C");
  } finally {
    await Effect.runPromise(h.engine.stop());
  }
});

test("whole observation failure preserves membership and performs no writes", async () => {
  const h = await setup();
  try {
    const writes = h.fake.writes().length;
    h.unavailable(true);
    await h.reconcile();
    expect(await home(h)).toBe("home");
    expect(h.fake.writes()).toHaveLength(writes);
    h.elapse(24 * 60 * 60 * 1000);
    h.unavailable(false);
    await h.reconcile();
    expect(await home(h)).toBe("home");
  } finally {
    await Effect.runPromise(h.engine.stop());
  }
});

test.each(["new pid", "new instance", "confirmed closure"])(
  "%s uses config rather than old assignment",
  async (reason) => {
    const h = await setup();
    try {
      h.absent(true);
      h.closed(reason === "confirmed closure");
      await h.reconcile();
      h.fake.removeWindow("cad");
      h.fake.addWindow(
        makeWindow({
          id: "cad",
          pid: reason === "new pid" ? 9 : 2,
          bundleId: "cad",
          instanceId: reason === "new instance" ? "replacement" : "original",
        }),
      );
      h.closed(false);
      h.absent(false);
      await h.reconcile();
      expect(await home(h)).toBe("3");
      expect((await h.state()).focusedWorkspace).toBe("C");
    } finally {
      await Effect.runPromise(h.engine.stop());
    }
  },
);

test("replacement is detected even without an intermediate missing snapshot", async () => {
  const h = await setup();
  try {
    h.fake.removeWindow("cad");
    h.fake.addWindow(makeWindow({ id: "cad", pid: 2, bundleId: "cad", instanceId: "replacement" }));
    await h.reconcile();
    expect(await home(h)).toBe("3");
  } finally {
    await Effect.runPromise(h.engine.stop());
  }
});

test("new focused configured window follows assignment; unmatched window uses current workspace", async () => {
  const h = await setup(true);
  try {
    h.fake.addWindow(makeWindow({ id: "new", pid: 9, bundleId: "cad" }));
    h.fake.focusWindowExternal("new");
    await Effect.runPromise(Effect.sleep("10 millis"));
    await h.reconcile();
    expect(await home(h, "new")).toBe("3");
    expect((await h.state()).focusedWorkspace).toBe("3");
    h.fake.addWindow(makeWindow({ id: "unmatched", pid: 10 }));
    await h.reconcile();
    expect(await home(h, "unmatched")).toBe("3");
  } finally {
    await Effect.runPromise(h.engine.stop());
  }
});

test("explicit close event retires a placement even when the same identity reappears", async () => {
  const h = await setup(true);
  try {
    h.fake.removeWindow("cad");
    await Effect.runPromise(Effect.sleep("10 millis"));
    h.fake.addWindow(makeWindow({ id: "cad", pid: 2, bundleId: "cad", instanceId: "original" }));
    await Effect.runPromise(Effect.sleep("10 millis"));
    await h.reconcile();
    expect(await home(h)).toBe("3");
  } finally {
    await Effect.runPromise(h.engine.stop());
  }
});

test("focused returning instance follows its preserved home", async () => {
  const h = await setup(true);
  try {
    h.absent(true);
    await h.reconcile();
    h.elapse(24 * 60 * 60 * 1000);
    h.absent(false);
    h.fake.focusWindowExternal("cad");
    await Effect.runPromise(Effect.sleep("10 millis"));
    await h.reconcile();
    expect(await home(h)).toBe("home");
    expect((await h.state()).focusedWorkspace).toBe("home");
  } finally {
    await Effect.runPromise(h.engine.stop());
  }
});
