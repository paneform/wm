import {
  parseScenario,
  parseScenarioCommand,
  runScenario,
  type LayoutScenario,
} from "@paneform/layout-browser";
import { describe, expect, it } from "vitest";
import {
  acceptCommandChoice,
  acceptTypedCommandToken,
  commandChoices,
  commandSlotHint,
  commandStateFromText,
  completedCommand,
  deriveCommandContext,
  emptyCommandState,
  reopenCommandToken,
  sanitizeCommandState,
  serializeCommandTokens,
  type CommandBuilderState,
} from "../src/lib/play/command-completions.js";

const scenario = parseScenario({
  config: { workspaces: [{ name: "Deep Work" }] },
  state: {
    topology: [
      { id: "main display", frame: { x: 0, y: 0, width: 1200, height: 800 }, workspace: "1" },
    ],
    windows: [{ id: "editor one", frame: { x: 10, y: 20, width: 600, height: 400 } }],
  },
  steps: [
    {
      event: {
        kind: "window_added",
        window: { id: "terminal", frame: { x: 0, y: 0, width: 500, height: 300 } },
      },
      caption: "draft",
    },
    { event: { kind: "window_removed", windowId: "editor one" } },
    {
      event: {
        kind: "topology_changed",
        topology: [{ id: "later", frame: { x: 0, y: 0, width: 800, height: 600 } }],
      },
    },
  ],
}) satisfies LayoutScenario;

function type(
  state: CommandBuilderState,
  query: string,
  context = deriveCommandContext(scenario, [], 0),
) {
  return acceptTypedCommandToken({ ...state, query }, context);
}

describe("guided command model", () => {
  it("preserves the selected target when a quoted token is reopened and accepted unchanged", async () => {
    const frame = { x: 0, y: 0, width: 1200, height: 800 };
    const document = parseScenario({
      state: {
        topology: [{ id: "main", frame, workspace: "1" }],
        windows: [
          { id: "A", frame },
          { id: " A ", frame },
        ],
        focusedWorkspace: "1",
        focusedWindow: "A",
      },
    });
    const context = deriveCommandContext(document);
    const reopened = reopenCommandToken(commandStateFromText('focus-window " A "', context)!);
    const choice = commandChoices(reopened, context)[0]!;
    expect(choice.value).toBe(" A ");
    const command = completedCommand(acceptCommandChoice(reopened, choice))!;
    expect(parseScenarioCommand(command)).toEqual({ type: "focusWindow", windowId: " A " });
    expect((await runScenario({ ...document, steps: [{ command }] })).focusedWindow).toBe(" A ");
  });
  it("shows only roots, then only valid next tokens", () => {
    const context = deriveCommandContext(scenario, [], 0);
    const roots = commandChoices(emptyCommandState(), context);
    expect(roots.map(({ value }) => value)).toContain("window");
    expect(roots).toHaveLength(new Set(roots.map(({ value }) => value)).size);
    const window = acceptCommandChoice(
      emptyCommandState(),
      roots.find(({ value }) => value === "window")!,
    );
    expect(commandChoices(window, context).map(({ value }) => value)).toEqual([
      "probe-limits",
      "focus",
      "move",
    ]);
  });

  it("builds a directional command one highlighted choice at a time", () => {
    const context = deriveCommandContext(scenario, [], 0);
    let state = emptyCommandState();
    for (const query of ["window", "move", "left"]) state = type(state, query, context)!;
    expect(completedCommand(state)).toBe("window move left");
  });

  it("keeps incomplete and invalid numbers out of completed commands", () => {
    const context = deriveCommandContext(scenario, [], 0);
    let state = emptyCommandState();
    for (const query of ["move-window", "editor one"]) {
      const choice = commandChoices({ ...state, query }, context).find(
        ({ value }) => value === query,
      )!;
      state = acceptCommandChoice(state, choice);
    }
    expect(type(state, "-", context)).toBeNull();
    expect(type(state, ".", context)).toBeNull();
    state = type(state, "-20.5", context)!;
    expect(type(state, "Infinity", context)).toBeNull();
    expect(type(state, "20", context)).not.toBeNull();
    expect(completedCommand(state)).toBeNull();
  });

  it("requires positive dimensions but permits negative coordinates", () => {
    const context = deriveCommandContext(scenario, [], 0);
    expect(commandStateFromText('move-window "editor one" -10 2.5', context)).not.toBeNull();
    expect(commandStateFromText('resize-window "editor one" -1 20', context)).toBeNull();
  });

  it("offers typed coordinates as choices for Space-style transitions", () => {
    const context = deriveCommandContext(scenario, [], 0);
    let state = emptyCommandState();
    for (const query of ["move-window", "editor one", "-10.5", "20"]) {
      const queried = { ...state, query };
      const choice = commandChoices(queried, context).find(({ value }) => value === query);
      expect(choice, query).toBeDefined();
      state = acceptCommandChoice(state, choice!);
    }
    expect(completedCommand(state)).toBe('move-window "editor one" -10.5 20');
  });

  it("advances from a typed new workspace to a known display", () => {
    const context = deriveCommandContext(scenario, [], 0);
    let state = emptyCommandState();
    for (const query of ["workspace", "move-display", '"Quiet Room"', "main display"]) {
      const choice = commandChoices({ ...state, query }, context)[0];
      expect(choice, query).toBeDefined();
      state = acceptCommandChoice(state, choice!);
    }
    expect(completedCommand(state)).toBe('workspace move-display "Quiet Room" "main display"');
  });

  it("tracks draft-added and removed windows and prefix topology", () => {
    expect(deriveCommandContext(scenario, scenario.steps, 1).windows).toContain("terminal");
    expect(deriveCommandContext(scenario, scenario.steps, 2).windows).not.toContain("editor one");
    expect(deriveCommandContext(scenario, scenario.steps, 2).displays).toEqual(["main display"]);
    expect(deriveCommandContext(scenario, scenario.steps, 3).displays).toEqual(["later"]);
  });

  it("quotes multiword values and accepts quoted new workspace names", () => {
    const context = deriveCommandContext(scenario, [], 0);
    const existing = commandStateFromText('workspace focus "Deep Work"', context)!;
    expect(serializeCommandTokens(existing.accepted)).toBe('workspace focus "Deep Work"');
    expect(commandStateFromText('workspace focus "Review Room"', context)).not.toBeNull();
    expect(commandStateFromText("workspace focus Review Room", context)).toBeNull();
    expect(type(type(emptyCommandState(), "workspace", context)!, "focus", context)).not.toBeNull();
    const focus = type(type(emptyCommandState(), "workspace", context)!, "focus", context)!;
    expect(type(focus, '"quiet', context)).toBeNull();
    expect(commandChoices({ ...focus, query: '"quiet' }, context)).toHaveLength(0);
    expect(commandStateFromText(`workspace focus "${"x".repeat(129)}"`, context)).toBeNull();
  });

  it("decodes quoted known references and escapes without double escaping", () => {
    const local = parseScenario({
      state: {
        topology: [
          { id: 'main "display"', frame: { x: 0, y: 0, width: 100, height: 100 }, workspace: "1" },
        ],
        windows: [{ id: 'editor "one"', frame: { x: 0, y: 0, width: 20, height: 20 } }],
      },
    });
    const context = deriveCommandContext(local);
    let typed = type(emptyCommandState(), "focus-window", context)!;
    const quotedChoice = commandChoices({ ...typed, query: '"editor \\"one\\""' }, context)[0];
    expect(quotedChoice?.value).toBe('editor "one"');
    typed = acceptCommandChoice(typed, quotedChoice!);
    expect(completedCommand(typed)).toBe('focus-window "editor \\"one\\""');
    const windowState = commandStateFromText('focus-window "editor \\"one\\""', context)!;
    expect(serializeCommandTokens(windowState.accepted)).toBe('focus-window "editor \\"one\\""');
    expect(
      commandStateFromText('workspace move-display 1 "main \\"display\\""', context),
    ).not.toBeNull();
  });

  it("provides short slot hints without reporting errors", () => {
    const context = deriveCommandContext(scenario, [], 0);
    let state = type(emptyCommandState(), "move-window", context)!;
    expect(commandSlotHint(state)).toBe("Choose window");
    state = acceptCommandChoice(state, commandChoices(state, context)[0]!);
    expect(commandSlotHint(state)).toBe("Enter x coordinate");
    let workspace = type(emptyCommandState(), "workspace", context)!;
    workspace = type(workspace, "focus", context)!;
    expect(commandSlotHint(workspace)).toBe("Enter workspace name");
  });

  it("sanitizes known workspace paths but retains allow-new workspace paths", () => {
    const context = deriveCommandContext(scenario, [], 0);
    const removed = { ...context, workspaces: ["1"] };
    const known = commandStateFromText('workspace mode "Deep Work" bsp', context)!;
    expect(sanitizeCommandState(known, removed).accepted.map(({ value }) => value)).toEqual([
      "workspace",
      "mode",
    ]);
    const allowNew = commandStateFromText(
      'workspace move-display "Deep Work" "main display"',
      context,
    )!;
    expect(sanitizeCommandState(allowNew, removed)).toBe(allowNew);
  });

  it("preserves the ambiguous window and workspace branch labels", () => {
    const local = parseScenario({
      state: {
        topology: [
          { id: "display", frame: { x: 0, y: 0, width: 100, height: 100 }, workspace: "same" },
        ],
        windows: [{ id: "same", frame: { x: 0, y: 0, width: 20, height: 20 } }],
      },
    });
    const context = deriveCommandContext(local);
    let state = emptyCommandState();
    state = type(state, "workspace", context)!;
    state = type(state, "move-window", context)!;
    expect(
      commandChoices(state, context)
        .filter(({ value }) => value === "same")
        .map(({ label }) => label)
        .sort(),
    ).toEqual(["Window", "Workspace"]);
  });

  it("prefills complete edits, optional arguments, service commands, and reopens tokens", () => {
    const context = deriveCommandContext(scenario, [], 0);
    expect(completedCommand(commandStateFromText("retile", context)!)).toBe("retile");
    expect(completedCommand(commandStateFromText("reload-config full", context)!)).toBe(
      "reload-config full",
    );
    expect(completedCommand(commandStateFromText("service restart", context)!)).toBe(
      "service restart",
    );
    const state = commandStateFromText("window move left", context)!;
    const direction = reopenCommandToken(state);
    expect(direction.query).toBe("left");
    expect(commandChoices({ ...direction, query: "" }, context).map(({ value }) => value)).toEqual([
      "left",
      "right",
      "up",
      "down",
      "workspace",
    ]);
    const reload = commandStateFromText("reload-config", context)!;
    expect(commandChoices(reload, context).map(({ value }) => value)).toEqual(["delta", "full"]);
    const service = reopenCommandToken(commandStateFromText("service start", context)!);
    expect(commandChoices({ ...service, query: "" }, context).map(({ value }) => value)).toEqual([
      "start",
      "stop",
      "restart",
    ]);
  });

  it("reserves case-sensitive exact references before the bounded prefix list", () => {
    const windows = [...Array.from({ length: 50 }, (_, index) => `editor-${index}`), "editor"];
    const context = { windows, displays: [], workspaces: [] };
    const focus = type(emptyCommandState(), "focus-window", context)!;
    expect(commandChoices({ ...focus, query: "editor" }, context)[0]?.value).toBe("editor");
    expect(
      commandChoices(
        { ...focus, query: "EDITOR" },
        { ...context, windows: ["editor", "EDITOR"] },
      )[0]?.value,
    ).toBe("EDITOR");
  });

  it("rejects flag-like values in every variable slot", () => {
    const context = {
      windows: ["A", "--toggle", "--__proto__"],
      displays: ["--toggle"],
      workspaces: ["--toggle", "--__proto__"],
    };
    for (const command of [
      "focus-window --toggle",
      "workspace focus --__proto__",
      "workspace move-window A --__proto__",
      "workspace move-display safe --toggle",
    ]) {
      expect(commandStateFromText(command, context), command).toBeNull();
    }
  });

  it("round-trips raw selected identifiers before parser validation", () => {
    const windows = ["A", " A ", "a\tb", String.raw`a\b`, 'a"b', String.raw`a\tb`];
    const displays = [" d ", "d\t1"];
    const workspaces = [" w ", "w\t1"];
    const context = { windows, displays, workspaces };
    for (const id of windows) {
      const state = commandStateFromText(`focus-window ${serializeRaw(id)}`, context)!;
      const command = completedCommand(state)!;
      expect(state.accepted[1]?.value).toBe(id);
      expect(parseScenarioCommand(command)).toEqual({ type: "focusWindow", windowId: id });
    }
    const move = commandStateFromText(
      `workspace move-display ${serializeRaw(workspaces[0]!)} ${serializeRaw(displays[0]!)}`,
      context,
    )!;
    expect(parseScenarioCommand(completedCommand(move)!)).toEqual({
      type: "moveWorkspaceToDisplay",
      workspace: " w ",
      displayId: " d ",
    });
  });

  it("caps each next-position list independently", () => {
    const large = parseScenario({
      config: {
        workspaces: Array.from({ length: 100 }, (_, index) => ({ name: `workspace-${index}` })),
      },
      state: {
        topology: [
          { id: "display", frame: { x: 0, y: 0, width: 100, height: 100 }, workspace: "1" },
        ],
        windows: [],
      },
    });
    const context = deriveCommandContext(large);
    let state = type(emptyCommandState(), "workspace", context)!;
    state = type(state, "focus", context)!;
    expect(commandChoices(state, context)).toHaveLength(50);
  });
});

function serializeRaw(value: string): string {
  return `"${value.replace(/[\\"]/gu, "\\$&")}"`;
}
