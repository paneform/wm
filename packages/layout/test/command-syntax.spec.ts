import { describe, expect, test } from "vitest";
import {
  buildCommand,
  buildKeybindCommand,
  commandPaths,
  describeCommandTokens,
  formatCommandHelp,
  serviceCommandPaths,
  parseCommandText,
  quoteCommandToken,
  tokenizeCommandText,
} from "../src/command-syntax.js";

describe("command syntax", () => {
  test("all published paths carry command and argument help", () => {
    for (const path of [...commandPaths, ...serviceCommandPaths]) {
      expect(path.description).toBeTruthy();
      for (const token of path.tokens) expect(token.description).toBeTruthy();
      expect(formatCommandHelp([path])).toContain(path.description);
    }
  });

  test("describes quoted arguments by role rather than their current value", () => {
    const tokens = describeCommandTokens('wm workspace move-window "My Window" "Deep Work"');
    expect(tokens.map(({ value }) => value)).toEqual([
      "wm",
      "workspace",
      "move-window",
      '"My Window"',
      '"Deep Work"',
    ]);
    expect(tokens[3]?.description).toContain("window ID");
    expect(tokens[4]?.description).toBe("The name of a workspace.");
    expect(tokens[2]?.description).toBe("Move a window to another workspace.");
    expect(describeCommandTokens("move-window w -100 200")[2]?.description).toContain(
      "negative values",
    );
  });
  test("maps directional, focus, and workspace commands", () => {
    expect(parseCommandText("wm window focus left")).toEqual({
      type: "focusDirection",
      direction: "left",
    });
    expect(parseCommandText("window move down")).toEqual({
      type: "moveDirection",
      direction: "down",
    });
    expect(parseCommandText('workspace focus "Deep Work"')).toEqual({
      type: "focusWorkspace",
      name: "Deep Work",
    });
    expect(parseCommandText("workspace move-window Deep\\ Work")).toEqual({
      type: "moveFocusedWindowToWorkspace",
      workspace: "Deep Work",
    });
  });

  test("parses supported flags and the existing keybind alias", () => {
    expect(parseCommandText("wm workspace pause --toggle")).toEqual({ type: "togglePause" });
    expect(buildKeybindCommand("window move workspace S")).toEqual({
      type: "moveFocusedWindowToWorkspace",
      workspace: "S",
    });
  });

  test("keeps quoted or escaped shell characters literal", () => {
    expect(parseCommandText("workspace focus 'review; do not run'")).toEqual({
      type: "focusWorkspace",
      name: "review; do not run",
    });
    expect(parseCommandText("workspace focus review\\&notes")).toEqual({
      type: "focusWorkspace",
      name: "review&notes",
    });
  });

  test("rejects shell syntax and malformed text", () => {
    for (const text of [
      "pause; resume",
      "pause | resume",
      "workspace focus $HOME",
      "workspace focus *",
      "workspace focus 'unfinished",
      "workspace focus trailing\\",
      "pause\nresume",
    ]) {
      expect(() => parseCommandText(text)).toThrow(/Invalid wm command/);
    }
  });

  test("rejects unknown arguments, flags, enums, and nonfinite numbers", () => {
    for (const text of [
      "state extra",
      "pause --toggle",
      "workspace focus dev --unknown",
      "workspace mode dev stack",
      "reload-config partial",
      "move-window w1 NaN 20",
      "resize-window w1 Infinity 20",
      "debug-frame set w1 0 0 800 nope",
      "retile --__proto__",
      "workspace move-window A --__proto__",
    ]) {
      expect(() => parseCommandText(text)).toThrow(/Invalid wm command/);
    }
  });

  test("quotes tokens without changing whitespace, escapes, or control characters", () => {
    for (const value of [" a ", "a\tb", "a\nb", String.raw`a\b`, 'a"b', String.raw`a\tb`]) {
      expect(tokenizeCommandText(quoteCommandToken(value))).toEqual([value]);
      expect(parseCommandText(`focus-window ${quoteCommandToken(value)}`)).toEqual({
        type: "focusWindow",
        windowId: value,
      });
    }
  });

  test("text, keybind, and direct builders share the same mapping", () => {
    const expected = { type: "moveWindowToWorkspace", windowId: "w1", workspace: "dev" };
    expect(buildCommand("workspace", ["move-window", "w1", "dev"])).toEqual(expected);
    expect(buildKeybindCommand("workspace move-window w1 dev")).toEqual(expected);
    expect(parseCommandText("wm workspace move-window w1 dev")).toEqual(expected);
  });

  test("every guided grammar path is accepted by the parser", () => {
    const value = {
      window: "window",
      display: "display",
      workspace: "workspace",
      coordinate: "-2.5",
      dimension: "2.5",
    } as const;
    for (const path of commandPaths) {
      const words = path.tokens.map((token) =>
        token.kind === "literal" ? token.value : value[token.slot],
      );
      expect(() => parseCommandText(words.join(" ")), words.join(" ")).not.toThrow();
      if (path.minimumTokens !== undefined)
        expect(() => parseCommandText(words.slice(0, path.minimumTokens).join(" "))).not.toThrow();
    }
  });
});
