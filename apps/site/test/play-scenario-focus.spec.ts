import { createScenarioSession, parseScenario, runScenario } from "@paneform/layout-browser";
import { describe, expect, it } from "vitest";
import {
  insertFocusStep,
  insertScenarioStep,
  insertScenarioSteps,
  mergeRecordedSteps,
  nextPlayWindowId,
  preservesExecutedSteps,
} from "../src/lib/play/scenario-focus.js";

const scenario = parseScenario({
  config: { defaults: { gap: 0 } },
  simulation: { os: { kind: "macos", horizontalFallback: 48, bottomVisible: 64 } },
  state: {
    topology: [{ id: "main", frame: { x: 0, y: 0, width: 1200, height: 800 }, workspace: "1" }],
    windows: [
      { id: "A", frame: { x: 0, y: 0, width: 600, height: 800 } },
      { id: "B", frame: { x: 600, y: 0, width: 600, height: 800 } },
    ],
    focusedWorkspace: "1",
    focusedWindow: "A",
  },
  steps: [{ command: "state" }, { command: "window move left" }],
});

describe("focus while editing a played scenario", () => {
  it("inserts focus at the current cursor and preserves the baseline and remaining steps", async () => {
    const next = insertFocusStep(scenario, 0, "B");
    expect(next.scenario.state).toEqual(scenario.state);
    expect(next.scenario.simulation).toEqual(scenario.simulation);
    expect(next.scenario.steps).toEqual([scenario.steps?.[0], next.step, scenario.steps?.[1]]);
    const session = await createScenarioSession(scenario);
    try {
      await session.step();
      await session.apply(next.step);
      const live = await session.apply(scenario.steps![1]!);
      expect(await runScenario(next.scenario)).toEqual(live);
    } finally {
      await session.dispose();
    }
  });

  it("does not record an unknown window or invalid cursor", () => {
    expect(() => insertFocusStep(scenario, 0, "missing")).toThrow();
    expect(() => insertFocusStep(scenario, -2, "A")).toThrow();
  });
});

describe("interactive actions after playback", () => {
  it("records Open App as one focused creation step and preserves the future sequence", async () => {
    const step = {
      event: {
        kind: "window_added",
        window: {
          id: "contacts",
          title: "Contacts",
          frame: { x: 100, y: 100, width: 400, height: 300 },
        },
        focus: true,
      },
      caption: "Open Contacts",
    } as const;
    const recorded = insertScenarioStep(scenario, 0, step);
    expect(recorded.index).toBe(1);
    expect(recorded.scenario.steps).toEqual([scenario.steps![0], step, scenario.steps![1]]);
    const session = await createScenarioSession(scenario);
    try {
      await session.step();
      expect((await session.apply(step)).focusedWindow).toBe("contacts");
      const live = await session.apply(scenario.steps![1]!);
      expect(await runScenario(recorded.scenario)).toEqual(live);
    } finally {
      await session.dispose();
    }
  });

  it("validates a launch sequence as one insertion before applying it", () => {
    const originalSteps = structuredClone(scenario.steps);
    const launch = [
      {
        event: {
          kind: "window_added" as const,
          window: { id: "launched", frame: { x: 10, y: 20, width: 300, height: 200 } },
        },
      },
      { event: { kind: "focus_changed" as const, windowId: "launched" } },
    ];
    const inserted = insertScenarioSteps(scenario, 0, launch);
    expect(inserted.scenario.steps).toEqual([scenario.steps![0], ...launch, scenario.steps![1]]);
    expect(() =>
      insertScenarioSteps(scenario, 0, [
        launch[0]!,
        { event: { kind: "focus_changed", windowId: "missing" } },
      ]),
    ).toThrow();
    expect(scenario.steps).toEqual(originalSteps);
  });

  it("reserves window aliases from the baseline, live state, and future steps", () => {
    const reserved = parseScenario({
      ...scenario,
      state: {
        ...scenario.state,
        windows: [{ ...scenario.state.windows[0]!, id: "window:play-1" }],
        focusedWindow: "window:play-1",
      },
      steps: [
        {
          event: {
            kind: "window_added",
            window: { id: "window:play-2", frame: { x: 0, y: 0, width: 100, height: 100 } },
          },
        },
      ],
    });
    expect(nextPlayWindowId(reserved, ["window:play-3"], 0)).toEqual({
      id: "window:play-4",
      sequence: 4,
    });
  });

  it("merges delayed recorded steps without losing presentation changes made during apply", async () => {
    const expected = parseScenario({ ...scenario, presentation: { animate: true } });
    const pendingApply = Promise.resolve(
      insertScenarioStep(expected, 0, { command: "state" }).scenario,
    );
    const latest = parseScenario({
      ...expected,
      presentation: { animate: false, showDock: false },
    });
    const recorded = await pendingApply;
    const merged = mergeRecordedSteps(latest, expected, recorded);
    expect(merged.steps).toEqual(recorded.steps);
    expect(merged.presentation).toMatchObject({ animate: false, showDock: false });
    expect(() => mergeRecordedSteps({ ...latest, steps: [] }, expected, recorded)).toThrow();
  });
  it("records before the first step without changing the baseline or suffix", async () => {
    const step = { event: { kind: "focus_changed" as const, windowId: "B" } };
    const next = insertScenarioStep(scenario, -1, step);
    expect(next.index).toBe(0);
    expect(next.scenario.state).toEqual(scenario.state);
    expect(next.scenario.steps).toEqual([step, ...scenario.steps!]);
    expect(await runScenario(next.scenario)).toEqual(
      await runScenario({ ...scenario, steps: [step, ...scenario.steps!] }),
    );
  });

  it("retains every stopped-WM physical prefix before startup and replays the startup result", async () => {
    let recorded = parseScenario({
      config: { defaults: { gap: 0 } },
      state: {
        topology: [{ id: "main", frame: { x: 0, y: 0, width: 1200, height: 800 }, workspace: "1" }],
        windows: [],
        focusedWorkspace: "1",
        focusedWindow: null,
        wmRunning: false,
      },
      steps: [],
    });
    const actions = [
      {
        event: {
          kind: "window_added" as const,
          window: { id: "created", frame: { x: 80, y: 60, width: 700, height: 500 } },
        },
      },
      { event: { kind: "focus_changed" as const, windowId: "created" } },
      {
        event: {
          kind: "window_added" as const,
          window: { id: "closed-before-start", frame: { x: 500, y: 200, width: 400, height: 300 } },
        },
      },
      {
        event: {
          kind: "window_changed" as const,
          window: { id: "created", frame: { x: 120, y: 90, width: 640, height: 480 } },
        },
      },
      { event: { kind: "window_removed" as const, windowId: "closed-before-start" } },
      { command: "service start" },
      { command: "workspace focus T" },
      { command: "workspace focus 1" },
    ];
    const session = await createScenarioSession(recorded);
    try {
      let cursor = -1;
      let live;
      let beforeStartup;
      for (const [index, action] of actions.entries()) {
        const next = insertScenarioStep(recorded, cursor, action);
        live = await session.apply(next.step);
        recorded = next.scenario;
        cursor = next.index;
        expect(
          await runScenario({ ...recorded, steps: recorded.steps?.slice(0, cursor + 1) }),
        ).toEqual(live);
        if (index < 5) expect(live.wmRunning).toBe(false);
        if (index === 4) beforeStartup = structuredClone(live);
        if (index === 5) {
          expect(beforeStartup?.wmRunning).toBe(false);
          expect(live.wmRunning).toBe(true);
          expect(live).not.toEqual(beforeStartup);
        }
      }
      expect(live).toEqual(await runScenario(recorded));
      expect(live?.windows[0]?.id).toBe("created");
      expect(live?.windows.some(({ id }) => id === "closed-before-start")).toBe(false);
      expect(live?.focusedWindow).toBe("created");
      expect(live?.wmRunning).toBe(true);
      expect(live?.focusedWorkspace).toBe("1");
    } finally {
      await session.dispose();
    }
  });
  it.each([
    { command: "workspace focus 2" },
    {
      event: {
        kind: "window_changed" as const,
        window: { id: "B", frame: { x: -2400, y: -1800, width: 700, height: 500 } },
      },
    },
    { event: { kind: "window_removed" as const, windowId: "B" } },
  ])("records a replayable action at the completed cursor", async (step) => {
    const baseline = parseScenario({
      ...scenario,
      steps: [{ command: "state", caption: "Original", duration: 20 }],
    });
    const next = insertScenarioStep(baseline, 0, step);
    expect(next.scenario.state).toEqual(baseline.state);
    expect(next.scenario.config).toEqual(baseline.config);
    expect(next.scenario.steps?.[0]).toEqual(baseline.steps?.[0]);
    const session = await createScenarioSession(baseline);
    try {
      await session.step();
      const live = await session.apply(step);
      expect(await runScenario(next.scenario)).toEqual(live);
    } finally {
      await session.dispose();
    }
  });

  it("retains suffix metadata and rejects a close that invalidates a future step", () => {
    const original = parseScenario({
      ...scenario,
      steps: [
        { command: "state" },
        {
          event: { kind: "focus_changed", windowId: "B" },
          caption: "Future focus",
          duration: 75,
          expect: { focusedWindow: "B" },
        },
      ],
    });
    const next = insertScenarioStep(original, 0, { command: "workspace focus 2" });
    expect(next.scenario.steps?.[2]).toEqual(original.steps?.[1]);
    expect(() =>
      insertScenarioStep(original, 0, { event: { kind: "window_removed", windowId: "B" } }),
    ).toThrow();
    expect(original.steps).toHaveLength(2);
  });

  it("retains the live cursor for appended steps, but not edits to executed steps", () => {
    const steps = scenario.steps!;
    expect(preservesExecutedSteps(steps, [...steps, { command: "state" }], 1, true)).toBe(true);
    expect(preservesExecutedSteps(steps, [steps[0]!, { command: "state" }], 0, true)).toBe(true);
    expect(preservesExecutedSteps(steps, [{ command: "pause" }, steps[1]!], 1, true)).toBe(false);
    expect(preservesExecutedSteps(steps, [steps[0]!], 1, true)).toBe(false);
    expect(preservesExecutedSteps([], [{ command: "state" }], -1, true)).toBe(true);
  });

  it("requires a new session after a failed step mutated physical state", async () => {
    const failed = parseScenario({
      ...scenario,
      steps: [{ command: "state" }, { command: "pause", expect: { paused: false } }],
    });
    const session = await createScenarioSession(failed);
    try {
      await session.step();
      await expect(session.step()).rejects.toThrow();
      expect((await session.snapshot()).paused).toBe(true);
      const edited = [failed.steps![0]!];
      expect(preservesExecutedSteps(failed.steps!, edited, 0, false)).toBe(false);
      expect((await runScenario({ ...failed, steps: edited })).paused).toBe(false);
    } finally {
      await session.dispose();
    }
  });
});
