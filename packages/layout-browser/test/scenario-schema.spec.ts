import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseScenario,
  playbackStartIndex,
  playbackSteps,
  scenarioJsonSchema,
  type LayoutScenario,
} from "../src/scenario.js";
import { windowDragFrame, windowDragPointer, windowDragTargetFrame } from "../src/window-drag.js";
import {
  describeScenarioCommandTokens,
  parseScenarioCommand,
  scenarioCommandPaths,
} from "../src/scenario-commands.js";

const frame = { x: 0, y: 0, width: 1440, height: 900 };
const authoringCheck = {
  state: {
    topology: [{ id: "display:main", frame, workspace: "1" }],
    windows: [{ id: "terminal", frame }],
  },
} satisfies LayoutScenario;
const base = () => ({
  state: {
    topology: [{ id: "display:main", frame, workspace: "1" }],
    windows: [{ id: "terminal", frame }],
    focusedWindow: "terminal",
    focusedWorkspace: "1",
  },
});

describe("layout scenario schema", () => {
  it("retains an optional playback boundary on command and event steps", () => {
    const scenario = parseScenario({
      ...base(),
      steps: [
        { command: "reconcile" },
        { playback: "start", event: { kind: "focus_changed", windowId: null } },
      ],
    });
    expect(playbackStartIndex(scenario.steps!)).toBe(1);
    expect(playbackSteps(scenario)).toEqual([scenario.steps![1]]);
    expect(playbackStartIndex([])).toBe(0);
    expect(playbackSteps(base())).toEqual([]);
  });

  it("rejects duplicate and unknown playback markers", () => {
    expect(() =>
      parseScenario({
        ...base(),
        steps: [
          { playback: "start", command: "reconcile" },
          { playback: "start", command: "state" },
        ],
      }),
    ).toThrow("at most one playback start marker");
    expect(() =>
      parseScenario({ ...base(), steps: [{ playback: "setup", command: "state" }] }),
    ).toThrow();
  });
  it("interpolates a clamped straight-line drag without changing dimensions", () => {
    const drag = {
      windowId: "terminal",
      displayId: "display:main",
      startFrame: { x: 100, y: 200, width: 640, height: 480 },
      from: { x: 30, y: 50 },
      to: { x: 90, y: 80 },
      duration: 25,
    } as const;
    expect(windowDragPointer(drag, -1)).toEqual(drag.from);
    expect(windowDragPointer(drag, 0.5)).toEqual({ x: 60, y: 65 });
    expect(windowDragPointer(drag, 2)).toEqual(drag.to);
    expect(windowDragFrame(drag, 0.5)).toEqual({
      x: 130,
      y: 215,
      width: 640,
      height: 480,
    });
    expect(windowDragTargetFrame(drag)).toEqual({
      x: 160,
      y: 230,
      width: 640,
      height: 480,
    });
  });

  it("validates portable drag references, duration, and derived coordinates", () => {
    const drag = {
      kind: "window_dragged" as const,
      windowId: "terminal",
      displayId: "display:future",
      startFrame: frame,
      from: { x: 10, y: 10 },
      to: { x: 30, y: 40 },
      duration: 25,
    };
    expect(() =>
      parseScenario({
        ...base(),
        steps: [
          { event: drag },
          { event: { kind: "topology_changed", topology: [{ id: "display:future", frame }] } },
        ],
      }),
    ).not.toThrow();

    for (const event of [
      { ...drag, windowId: "missing" },
      { ...drag, displayId: "missing" },
      { ...drag, duration: 0 },
      { ...drag, duration: 60_001 },
      { ...drag, duration: Number.POSITIVE_INFINITY },
      {
        ...drag,
        displayId: "display:main",
        startFrame: { ...frame, x: 10_000_000 },
        from: { x: -10_000_000, y: 0 },
        to: { x: 10_000_000, y: 0 },
      },
    ]) {
      expect(() => parseScenario({ ...base(), steps: [{ event }] })).toThrow();
    }
  });

  it("validates optional focus-on-add as a boolean on window creation only", () => {
    const window = { id: "new", frame };
    expect(
      parseScenario({
        ...base(),
        steps: [{ event: { kind: "window_added", window, focus: true } }],
      }).steps?.[0],
    ).toMatchObject({ event: { focus: true } });
    expect(() =>
      parseScenario({
        ...base(),
        steps: [{ event: { kind: "window_added", window, focus: "true" } }],
      }),
    ).toThrow();
    expect(() =>
      parseScenario({
        ...base(),
        steps: [
          { event: { kind: "window_changed", window: { id: "terminal", frame }, focus: true } },
        ],
      }),
    ).toThrow();
  });

  it("uses shared token syntax and help for service commands", () => {
    expect(() =>
      parseScenarioCommand("window frame set 10 20 800 600 --window terminal"),
    ).toThrow();
    expect(parseScenarioCommand('wm service "start"')).toEqual({
      type: "service",
      action: "start",
    });
    expect(() => parseScenario({ ...base(), steps: [{ command: "service\nstart" }] })).toThrow();
    expect(describeScenarioCommandTokens("service\nstart")).toEqual([
      { value: "service\nstart", description: "This command is invalid; edit it before replay." },
    ]);
    expect(describeScenarioCommandTokens("service start")[1]?.description).toBe(
      "Start the window manager and manage the current desktop.",
    );
    for (const path of scenarioCommandPaths) {
      expect(path.description).toBeTruthy();
      for (const token of path.tokens) expect(token.description).toBeTruthy();
    }
  });

  it("publishes the same JSON Schema used by runtime authoring tools", () => {
    const published = JSON.parse(
      readFileSync(new URL("../scenario.schema.json", import.meta.url), "utf8"),
    );
    expect(published).toEqual(scenarioJsonSchema);
  });
  it("allows authoring documents to omit decoded defaults", () => {
    expect(authoringCheck.state.windows).toHaveLength(1);
  });

  it("generates an annotated closed JSON Schema", () => {
    expect(scenarioJsonSchema).toMatchObject({
      $schema: "http://json-schema.org/draft-07/schema#",
      $ref: "#/$defs/LayoutScenario",
    });
    expect(scenarioJsonSchema.$defs?.LayoutScenario).toMatchObject({
      title: "Paneform layout scenario",
      additionalProperties: false,
      required: ["state"],
    });
    expect(JSON.stringify(scenarioJsonSchema)).toContain("Presentation duration");
    expect(JSON.stringify(scenarioJsonSchema)).toContain('"maxProperties":100');
    expect(JSON.stringify(scenarioJsonSchema)).toContain('"maxProperties":500');
  });

  it("applies documented defaults and accepts optional combinations", () => {
    expect(parseScenario(base())).toMatchObject({
      state: {
        topology: [{ scale: 1, workspace: "1" }],
        windows: [{ workspace: "1" }],
        focusedWindow: "terminal",
      },
    });
    expect(
      parseScenario({
        state: { topology: [], windows: [] },
        steps: [{ event: { kind: "focus_changed", windowId: null }, caption: "Nothing selected" }],
      }).state,
    ).toMatchObject({ focusedWindow: null, focusedWorkspace: null });
    expect(
      parseScenario({
        ...base(),
        presentation: {
          comparison: "cooperative-macos",
          devices: { "display:main": "display" },
          showWindowSettings: false,
        },
        config: { experiments: { directionalMoveGroups: true } },
      }),
    ).toMatchObject({
      presentation: {
        comparison: "cooperative-macos",
        device: "laptop",
        showKeyboard: true,
        showDock: true,
        showTopBar: true,
        showWindowSettings: false,
        allowMove: true,
        allowResize: true,
        animate: true,
      },
      config: { experiments: { directionalMoveGroups: true } },
      state: { wmRunning: true },
    });
  });

  it("rejects unknown comparison modes", () => {
    expect(() =>
      parseScenario({ ...base(), presentation: { comparison: "competitive-macos" } }),
    ).toThrow();
  });

  it("accepts configurable linked comparison environments", () => {
    const comparison = {
      primary: { label: "Strict", subtext: "first", os: { kind: "macos" as const } },
      secondary: { label: "Free", subtext: "second", os: "none" as const },
    };
    expect(
      parseScenario({ ...base(), presentation: { comparison } }).presentation?.comparison,
    ).toEqual(comparison);
    expect(
      parseScenario({
        ...base(),
        presentation: {
          comparison: {
            primary: { label: "x".repeat(80), subtext: "x".repeat(160), os: "none" },
            secondary: { label: "Same OS", subtext: "", os: "none" },
          },
        },
      }).presentation?.comparison,
    ).toBeDefined();
    const blank = {
      primary: { label: "", subtext: "", os: "none" as const },
      secondary: { label: "", subtext: "", os: { kind: "macos" as const } },
    };
    expect(
      parseScenario({ ...base(), presentation: { comparison: blank } }).presentation,
    ).toMatchObject({ comparison: blank });
  });

  it.each([
    ["long label", { label: "x".repeat(81), subtext: "", os: "none" }],
    ["long subtext", { label: "Valid", subtext: "x".repeat(161), os: "none" }],
    ["missing label", { subtext: "", os: "none" }],
    ["missing subtext", { label: "Valid", os: "none" }],
    ["missing OS", { label: "Valid", subtext: "" }],
  ])("rejects comparison environment with %s", (_name, environment) => {
    expect(() =>
      parseScenario({
        ...base(),
        presentation: {
          comparison: { primary: environment, secondary: environment },
        },
      }),
    ).toThrow();
  });

  it.each([
    undefined,
    "none" as const,
    { kind: "macos" as const },
    { kind: "macos" as const, horizontalFallback: 40, bottomVisible: 52 },
  ])("accepts simulation OS rules %j", (os) => {
    const input = os === undefined ? base() : { ...base(), simulation: { os } };
    expect(parseScenario(input).simulation?.os).toEqual(os);
  });

  it.each([
    {},
    { os: "macos" },
    { os: { kind: "windows" } },
    { os: { kind: "macos", horizontalFallback: 0 } },
    { os: { kind: "macos", horizontalFallback: Number.POSITIVE_INFINITY } },
    { os: { kind: "macos", bottomVisible: -1 } },
    { os: { kind: "macos", bottomVisible: 10_001 } },
  ])("rejects invalid simulation options %j", (simulation) => {
    expect(() => parseScenario({ ...base(), simulation })).toThrow();
  });

  it("allows presentation overrides for displays introduced by later topology", () => {
    expect(() =>
      parseScenario({
        ...base(),
        presentation: { devices: { "display:future": "display" } },
        steps: [
          {
            event: {
              kind: "topology_changed",
              topology: [{ id: "display:future", frame }],
            },
          },
        ],
      }),
    ).not.toThrow();
  });

  it.each([
    ["root extras", { ...base(), version: 1 }],
    [
      "both command and event",
      { ...base(), steps: [{ command: "state", event: { kind: "wake" } }] },
    ],
    ["malformed command", { ...base(), steps: [{ command: "rm -rf /" }] }],
    [
      "unknown command window",
      { ...base(), steps: [{ command: "window focus --window missing" }] },
    ],
    [
      "unknown command display",
      { ...base(), steps: [{ command: "workspace move display missing --workspace 1" }] },
    ],
    [
      "unknown event window",
      { ...base(), steps: [{ event: { kind: "window_removed", windowId: "missing" } }] },
    ],
    [
      "duplicate windows",
      { state: { ...base().state, windows: [base().state.windows[0], base().state.windows[0]] } },
    ],
    [
      "duplicate workspaces",
      {
        state: {
          ...base().state,
          topology: [...base().state.topology, { id: "display:other", frame, workspace: "1" }],
        },
      },
    ],
    [
      "contradictory limits",
      {
        state: {
          ...base().state,
          windows: [{ id: "terminal", frame, constraints: { minWidth: 900, maxWidth: 800 } }],
        },
      },
    ],
    [
      "empty workspace",
      {
        state: {
          ...base().state,
          topology: [{ id: "display:main", frame, workspace: "" }],
        },
      },
    ],
    [
      "coordinate bound",
      {
        state: {
          ...base().state,
          windows: [{ id: "terminal", frame: { ...frame, x: 10_000_001 } }],
        },
      },
    ],
    [
      "step bound",
      { ...base(), steps: Array.from({ length: 501 }, () => ({ event: { kind: "wake" } })) },
    ],
    [
      "event error expectation",
      { ...base(), steps: [{ event: { kind: "wake" }, expect: { error: "paused" } }] },
    ],
    ["invalid config display selector", { ...base(), config: { displays: [{ display: "main" }] } }],
    [
      "long config workspace name",
      { ...base(), config: { workspaces: [{ name: "w".repeat(129) }] } },
    ],
    [
      "long preferred display",
      {
        ...base(),
        config: { workspaces: [{ name: "1", preferredDisplay: "d".repeat(129) }] },
      },
    ],
    [
      "long assignment matcher",
      {
        ...base(),
        config: { workspaces: [{ name: "1", assign: [{ title: "x".repeat(513) }] }] },
      },
    ],
    [
      "stopped and paused",
      { ...base(), state: { ...base().state, wmRunning: false, paused: true } },
    ],
    [
      "unknown presentation display",
      { ...base(), presentation: { devices: { missing: "display" } } },
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => parseScenario(input)).toThrow();
  });

  it("tracks event additions, removals, topology replacement, and expected absence", () => {
    const scenario = parseScenario({
      ...base(),
      steps: [
        { event: { kind: "window_added", window: { id: "editor", frame } } },
        { command: "window focus --window editor" },
        {
          event: { kind: "window_removed", windowId: "editor" },
          expect: { windows: { editor: { exists: false } } },
        },
        { event: { kind: "topology_changed", topology: [{ id: "display:new", frame }] } },
        { command: "workspace move display display:new --workspace 1" },
      ],
    });
    expect(scenario.steps).toHaveLength(5);
  });

  it("limits live windows added by events", () => {
    const input = {
      state: { topology: base().state.topology, windows: [] },
      steps: Array.from({ length: 101 }, (_, index) => ({
        event: { kind: "window_added" as const, window: { id: `window-${index}`, frame } },
      })),
    };
    expect(() => parseScenario(input)).toThrow(/100 live windows/);
  });

  it("rejects reserved record keys without prototype pollution", () => {
    const pollutedBefore = Object.hasOwn(Object.prototype, "polluted");
    const expectation = JSON.parse('{"__proto__":{"exists":false}}');
    const keybinds = JSON.parse('{"__proto__":"state"}');
    const devices = JSON.parse('{"__proto__":"display"}');

    expect(() =>
      parseScenario({ ...base(), steps: [{ command: "state", expect: { windows: expectation } }] }),
    ).toThrow(/reserved key/);
    expect(() => parseScenario({ ...base(), config: { keybinds } })).toThrow(/reserved key/);
    expect(() => parseScenario({ ...base(), presentation: { devices } })).toThrow(/reserved key/);
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(pollutedBefore);
  });

  it("keeps normal title matcher semantics", () => {
    expect(() =>
      parseScenario({
        ...base(),
        config: { workspaces: [{ name: "1", assign: [{ title: "^(Terminal|Editor)$" }] }] },
      }),
    ).not.toThrow();
  });

  it("rejects oversized malformed collections with a bounded error", () => {
    const malformed = Array.from({ length: 501 }, () => ({ command: 42, extra: { deep: true } }));
    let message = "";
    try {
      parseScenario({ ...base(), steps: malformed });
    } catch (error) {
      message = String(error);
    }
    expect(message).toMatch(/steps exceeds 500 items/);
    expect(message.length).toBeLessThan(10_000);
  });
});
