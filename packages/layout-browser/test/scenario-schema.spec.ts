import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseScenario, scenarioJsonSchema, type LayoutScenario } from "../src/scenario.js";
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
        presentation: { devices: { "display:main": "display" } },
        config: { experiments: { directionalMoveGroups: true } },
      }),
    ).toMatchObject({
      presentation: {
        device: "laptop",
        showKeyboard: true,
        showDock: true,
        showTopBar: true,
        allowMove: true,
        allowResize: true,
        animate: true,
      },
      config: { experiments: { directionalMoveGroups: true } },
      state: { wmRunning: true },
    });
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
    ["unknown command window", { ...base(), steps: [{ command: "focus-window missing" }] }],
    [
      "unknown command display",
      { ...base(), steps: [{ command: "workspace move-display 1 missing" }] },
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
        { command: "focus-window editor" },
        {
          event: { kind: "window_removed", windowId: "editor" },
          expect: { windows: { editor: { exists: false } } },
        },
        { event: { kind: "topology_changed", topology: [{ id: "display:new", frame }] } },
        { command: "workspace move-display 1 display:new" },
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
