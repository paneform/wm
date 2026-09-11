import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { createScenarioSession, runScenario } from "../src/scenario-runner.js";
import { parseScenario, type LayoutScenario } from "../src/scenario.js";

const frame = { x: 0, y: 0, width: 1200, height: 800 };
const base = {
  state: {
    topology: [{ id: "display:main", frame, workspace: "1" }],
    windows: [
      { id: "A", frame: { x: 13, y: -12, width: 520, height: 650 } },
      { id: "B", frame: { x: 233, y: 141, width: 720, height: 590 } },
    ],
    focusedWorkspace: "1",
    focusedWindow: "A",
  },
} as const satisfies LayoutScenario;

describe("portable scenario runner", () => {
  it.each([
    { wmRunning: false, paused: false },
    { wmRunning: true, paused: false },
    { wmRunning: true, paused: true },
  ])(
    "opens and focuses a window in one step with running=$wmRunning paused=$paused",
    async (mode) => {
      const openedFrame = { x: 120, y: 80, width: 650, height: 450 };
      const step = {
        event: {
          kind: "window_added",
          window: { id: "C", title: "Contacts", frame: openedFrame },
          focus: true,
        },
        caption: "Open Contacts",
        expect: { focusedWindow: "C" },
      } as const;
      const input = {
        ...base,
        state: { ...base.state, ...mode },
        steps: [step],
      } satisfies LayoutScenario;
      const session = await createScenarioSession(input);
      try {
        expect((await session.snapshot()).focusedWindow).toBe("A");
        const after = (await session.step())?.state;
        expect(after?.focusedWindow).toBe("C");
        expect(after?.windows.map(({ id }) => id)).toContain("C");
        if (!mode.wmRunning || mode.paused)
          expect(after?.windows.find(({ id }) => id === "C")?.frame).toEqual(openedFrame);
        expect(await session.step()).toBeNull();
        expect(await runScenario(input)).toEqual(after);
      } finally {
        await session.dispose();
      }
    },
  );

  it.each([undefined, false])(
    "preserves existing focus for a background window addition with focus=%s",
    async (focus) => {
      const window = { id: "C", frame: { x: 20, y: 20, width: 300, height: 200 } };
      const event =
        focus === undefined
          ? { kind: "window_added" as const, window }
          : { kind: "window_added" as const, window, focus };
      const after = await runScenario({
        ...base,
        state: { ...base.state, wmRunning: false },
        steps: [{ event }],
      });
      expect(after.focusedWindow).toBe("A");
      expect(after.windows.map(({ id }) => id)).toContain("C");
    },
  );

  it.each([["window focus left"], ["workspace focus 2", "workspace focus 1"]])(
    "preserves an imported asymmetric T layout after %s",
    async (...commands) => {
      const input = {
        config: { defaults: { gap: 0 } },
        state: {
          topology: [
            { id: "display:main", frame: { x: 0, y: 0, width: 1000, height: 800 }, workspace: "1" },
          ],
          windows: [
            { id: "A", frame: { x: 0, y: 0, width: 400, height: 800 } },
            { id: "B", frame: { x: 400, y: 0, width: 600, height: 560 } },
            { id: "C", frame: { x: 400, y: 560, width: 600, height: 240 } },
          ],
          focusedWorkspace: "1",
          focusedWindow: "B",
        },
      } satisfies LayoutScenario;
      const session = await createScenarioSession(input);
      try {
        const before = await session.snapshot();
        const beforeTree = (await Effect.runPromise(session.engine!.state())).workspaces[0]!.tree;
        for (const command of commands) await session.apply({ command });
        const after = await session.snapshot();
        expect(after.windows.map(({ id, frame }) => ({ id, frame }))).toEqual(
          before.windows.map(({ id, frame }) => ({ id, frame })),
        );
        expect(
          (await Effect.runPromise(session.engine!.state())).workspaces.find(
            ({ name }) => name === "1",
          )?.tree,
        ).toEqual(beforeTree);
        if (commands.length === 1) expect(after.focusedWindow).toBe("A");
      } finally {
        await session.dispose();
      }
    },
  );

  it("loads exact geometry, optional bounds, null membership, and explicit visibility without repair", async () => {
    const input = {
      config: { workspaces: [{ name: "config-only" }] },
      state: {
        ...base.state,
        topology: [{ id: "display:main", frame, workspace: "empty" }],
        windows: [
          { ...base.state.windows[0], constraints: { minWidth: 800 }, hidden: true },
          { ...base.state.windows[1], workspace: null },
        ],
        focusedWindow: null,
        focusedWorkspace: "empty",
      },
    } satisfies LayoutScenario;
    const session = await createScenarioSession(input);
    try {
      const before = await session.snapshot();
      expect(before.windows.map((window) => window.frame)).toEqual(
        input.state.windows.map((window) => window.frame),
      );
      expect(before.windows.map((window) => window.workspace)).toEqual(["1", null]);
      expect(before.windows[0]?.constraints).toEqual({ minWidth: 800 });
      expect(before.focusedWindow).toBeNull();
      expect(before.topology[0]?.workspace).toBe("empty");
      const observations = await Effect.runPromise(session.sim.adapter.getWindows());
      expect(observations[0]?.constraints).toBeUndefined();
      expect(observations[0]?.hidden).toBe(true);
      const committed = await Effect.runPromise(session.engine!.state());
      expect(committed.workspaces.map((workspace) => workspace.name).sort()).toEqual([
        "1",
        "empty",
      ]);
      expect(await session.step()).toBeNull();
      expect(await session.snapshot()).toEqual(before);
    } finally {
      await session.dispose();
    }
  });

  it("runs the same CLI steps deterministically and ignores presentation delays", async () => {
    const input = {
      ...base,
      steps: [
        { command: "retile", caption: "Take form.", duration: 60_000 },
        { command: "wm focus-window B", expect: { focusedWindow: "B" } },
        {
          command: 'workspace move-window "quiet work"',
          expect: {
            focusedWorkspace: "quiet work",
            windows: { B: { workspace: "quiet work" } },
          },
        },
      ],
    } satisfies LayoutScenario;
    const first = await runScenario(input);
    expect(await runScenario(input)).toEqual(first);
    expect(first.focusedWindow).toBe("B");
    expect(first.topology[0]?.workspace).toBe("quiet work");
  });

  it("applies platform events to physical state and reconciles their scheduled work", async () => {
    const input = {
      ...base,
      steps: [
        { event: { kind: "focus_changed", windowId: "B" }, expect: { focusedWindow: "B" } },
        { event: { kind: "window_added", window: { id: "C", frame } } },
        {
          event: { kind: "window_removed", windowId: "C" },
          expect: { windows: { C: { exists: false } } },
        },
        { command: "float A" },
        {
          event: {
            kind: "window_changed",
            window: { id: "A", frame: { ...frame, width: 700 }, constraints: { maxWidth: 750 } },
          },
          expect: { windows: { A: { floating: true, frame: { width: 700 } } } },
        },
      ],
    } satisfies LayoutScenario;
    const result = await runScenario(input);
    expect(result.windows.find((window) => window.id === "A")?.constraints).toEqual({
      maxWidth: 750,
    });
  });

  it("can remove the last window", async () => {
    const session = await createScenarioSession({
      state: { ...base.state, windows: [base.state.windows[0]] },
      steps: [
        {
          event: { kind: "window_removed", windowId: "A" },
          expect: {
            focusedWindow: null,
            windows: { A: { exists: false } },
          },
        },
      ],
    });
    try {
      await session.run();
      expect((await Effect.runPromise(session.engine!.state())).windows).toEqual([]);
    } finally {
      await session.dispose();
    }
  });

  it("reports fresh physical frames after event-driven writes without a hidden reconcile", async () => {
    const session = await createScenarioSession({
      state: { ...base.state, windows: [base.state.windows[0]] },
      steps: [{ event: { kind: "wake" }, expect: { windows: { A: { frame } } } }],
    });
    try {
      const result = await session.step();
      const physical = await Effect.runPromise(session.sim.adapter.getWindows());
      expect(result?.state.windows[0]?.frame).toEqual(physical[0]?.frame);
      expect(result?.state.windows[0]?.frame).toEqual(frame);
    } finally {
      await session.dispose();
    }
  });

  it("accepts expected command errors and stops on unexpected failures", async () => {
    const paused = { ...base, state: { ...base.state, paused: true } };
    const pausedSession = await createScenarioSession(paused);
    try {
      expect((await pausedSession.snapshot()).windows.map((window) => window.frame)).toEqual(
        base.state.windows.map((window) => window.frame),
      );
    } finally {
      await pausedSession.dispose();
    }
    await runScenario({
      ...paused,
      steps: [{ command: "move-window A 50 50", expect: { error: "paused" } }],
    });
    await expect(
      runScenario({ ...paused, steps: [{ command: "move-window A 50 50" }] }),
    ).rejects.toThrow("Step 1: paused");
    const session = await createScenarioSession({
      ...base,
      steps: [{ command: "state", expect: { focusedWindow: "B" } }, { command: "retile" }],
    });
    try {
      await expect(session.step()).rejects.toThrow("Expected focusedWindow");
      await expect(session.step()).rejects.toThrow("reset");
    } finally {
      await session.dispose();
    }
  });

  it("replaces topology atomically and keeps ordinary signals scriptable", async () => {
    const result = await runScenario({
      ...base,
      steps: [
        {
          event: {
            kind: "topology_changed",
            topology: [
              { id: "display:main", frame: { ...frame, width: 1600 } },
              { id: "display:side", frame: { ...frame, x: -1200 } },
            ],
          },
        },
        { command: "workspace move-display 1 display:side" },
        { event: { kind: "sleep" } },
        { event: { kind: "wake" } },
        { event: { kind: "space_changed" } },
      ],
    });
    expect(result.topology.find((display) => display.id === "display:side")?.workspace).toBe("1");
  });

  it("queues concurrent steps and disposes safely during execution", async () => {
    const session = await createScenarioSession({ ...base, steps: [{ command: "retile" }] });
    const first = session.step();
    const second = session.step();
    await expect(first).resolves.not.toBeNull();
    await expect(second).resolves.toBeNull();
    await Promise.all([session.dispose(), session.dispose()]);
    await expect(session.step()).rejects.toThrow("disposed");
    await expect(session.snapshot()).rejects.toThrow("disposed");
  });

  it("does not sample an intermediate frame when reading during a multi-step run", async () => {
    const input = {
      state: {
        ...base.state,
        windows: [
          { id: "A", frame: { x: 0, y: 0, width: 500, height: 800 } },
          { id: "B", frame: { x: 500, y: 0, width: 500, height: 800 } },
        ],
      },
      steps: [{ command: "state" }, { command: "resize-window A 700 700" }, { command: "state" }],
    } satisfies LayoutScenario;
    const sequential = await createScenarioSession(input);
    const settledFrames = [(await sequential.snapshot()).windows[0]?.frame];
    try {
      for (
        let result = await sequential.step();
        result !== null;
        result = await sequential.step()
      ) {
        settledFrames.push(result.state.windows[0]?.frame);
      }
    } finally {
      await sequential.dispose();
    }
    const concurrent = await createScenarioSession(input);
    try {
      const [, snapshot] = await Promise.all([concurrent.run(), concurrent.snapshot()]);
      expect(settledFrames).toContainEqual(snapshot.windows[0]?.frame);
    } finally {
      await concurrent.dispose();
    }
  });

  it("keeps a stopped desktop physical and performs ordinary startup on service commands", async () => {
    const original = base.state.windows.map((window) => window.frame);
    const session = await createScenarioSession({
      ...base,
      config: { workspaces: [{ name: "assigned", assign: [{ title: "^A$" }] }] },
      state: { ...base.state, wmRunning: false },
    });
    try {
      expect(session.engine).toBeNull();
      expect((await session.snapshot()).windows.map((window) => window.frame)).toEqual(original);
      await session.apply({
        event: {
          kind: "window_changed",
          window: { id: "A", frame: { x: 40, y: 50, width: 600, height: 500 } },
        },
      });
      const started = await session.apply({
        command: "service start",
        expect: { wmRunning: true, windows: { A: { workspace: "assigned" } } },
      });
      expect(session.engine).not.toBeNull();
      expect(started.windows.map((window) => window.frame)).not.toEqual([
        { x: 40, y: 50, width: 600, height: 500 },
        original[1],
      ]);
      await session.apply({ command: "wm service stop", expect: { wmRunning: false } });
      expect(session.engine).toBeNull();
      expect((await session.snapshot()).paused).toBe(false);
      await session.apply({ command: "service restart", expect: { wmRunning: true } });
      expect(session.engine).not.toBeNull();
    } finally {
      await session.dispose();
    }
  });

  it("accepts physical edits while stopped or paused and reports stopped command errors", async () => {
    const session = await createScenarioSession({
      state: { ...base.state, windows: [], focusedWindow: null, wmRunning: false },
    });
    try {
      await session.apply({
        event: { kind: "window_added", window: { id: "C", frame } },
        expect: { windows: { C: { workspace: "1" } } },
      });
      await session.apply({ command: "move-window C 20 30", expect: { error: "wm_not_running" } });
      await expect(session.apply({ command: "move-window C 20 30" })).rejects.toThrow(
        "wm_not_running",
      );
      await session.apply({ event: { kind: "focus_changed", windowId: "C" } });
      await session.apply({ event: { kind: "window_removed", windowId: "C" } });
      expect((await session.snapshot()).windows).toEqual([]);
    } finally {
      await session.dispose();
    }

    const paused = await createScenarioSession({ ...base, state: { ...base.state, paused: true } });
    try {
      const changed = await paused.apply({
        event: { kind: "window_changed", window: { id: "A", frame, constraints: {} } },
      });
      expect(changed.paused).toBe(true);
      expect(changed.windows.find((window) => window.id === "A")?.constraints).toEqual({});
    } finally {
      await paused.dispose();
    }
  });

  it("keeps live errors recoverable and applies rapid inputs in FIFO order", async () => {
    const session = await createScenarioSession(base);
    try {
      await expect(
        session.apply({ event: { kind: "window_removed", windowId: "missing" } }),
      ).rejects.toThrow();
      const focus = session.apply({ event: { kind: "focus_changed", windowId: "B" } });
      const close = session.apply({ event: { kind: "window_removed", windowId: "B" } });
      expect((await focus).focusedWindow).toBe("B");
      expect((await close).windows.some((window) => window.id === "B")).toBe(false);
      expect((await session.snapshot()).focusedWindow).not.toBe("B");
    } finally {
      await session.dispose();
    }
  });

  it("replays captured live steps to the same final state", async () => {
    const steps = [
      { event: { kind: "focus_changed" as const, windowId: "B" } },
      { command: "float B" },
      { event: { kind: "window_removed" as const, windowId: "A" } },
    ];
    const live = await createScenarioSession(base);
    let liveState: Awaited<ReturnType<typeof live.snapshot>>;
    try {
      for (const step of steps) await live.apply(step);
      liveState = await live.snapshot();
    } finally {
      await live.dispose();
    }
    expect(await runScenario({ ...base, steps })).toEqual(liveState);
  });

  it("rebuilds display assignments after moving a workspace", async () => {
    const session = await createScenarioSession(base);
    try {
      await session.apply({
        event: {
          kind: "topology_changed",
          topology: [
            { id: "display:main", frame },
            { id: "display:side", frame: { ...frame, x: 1200 } },
          ],
        },
      });
      const moved = await session.apply({ command: "workspace move-display 1 display:side" });
      expect(moved.topology).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "display:main", workspace: null }),
          expect.objectContaining({ id: "display:side", workspace: "1" }),
        ]),
      );
      await expect(session.apply({ command: "state" })).resolves.toMatchObject({
        wmRunning: true,
      });
    } finally {
      await session.dispose();
    }
  });

  it("projects unrepresented engine focus as null without blocking later inputs", async () => {
    const session = await createScenarioSession({
      state: {
        topology: [{ id: "display:main", frame, workspace: "1" }],
        windows: [],
        focusedWorkspace: "1",
        wmRunning: true,
      },
    });
    try {
      const moved = await session.apply({ command: "workspace move-display 2 display:main" });
      expect(moved).toMatchObject({
        focusedWorkspace: null,
        topology: [{ id: "display:main", workspace: "2" }],
      });
      expect(() => parseScenario({ state: moved })).not.toThrow();
      await expect(session.apply({ command: "workspace focus 2" })).resolves.toMatchObject({
        focusedWorkspace: "2",
      });
      const stopped = await session.apply({ command: "service stop" });
      expect(stopped.wmRunning).toBe(false);
      expect(() => parseScenario({ state: stopped })).not.toThrow();
    } finally {
      await session.dispose();
    }
  });
});
