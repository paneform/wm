import { describe, expect, test } from "vitest";
import {
  commandPaths,
  serviceCommandPaths,
  parseCommandTokens,
  parseCommandText,
  quoteCommandToken,
  tokenizeCommandText,
  buildKeybindCommand,
  formatCommandParseError,
} from "../src/command-syntax.js";
import { decodeCommandSync } from "../src/commands.js";

describe("shared command parser", () => {
  test("unknown commands and malformed text carry readable errors and help", () => {
    const unknown = parseCommandText("wm doctor");
    expect(unknown).toMatchObject({
      ok: false,
      error: { message: "doctor is not a command recognized by wm." },
    });
    if (!unknown.ok) expect(formatCommandParseError(unknown.error)).toContain("\n\nUsage:\n");
    const missing = parseCommandText("window assign 2 --window");
    if (!missing.ok) {
      expect(missing.error.help).toContain("window assign");
      expect(missing.error.help).not.toContain("service start");
    }
    expect(parseCommandText('window assign "oops')).toMatchObject({
      ok: false,
      error: { message: "Cannot parse command: unterminated quote", help: expect.any(String) },
    });
  });
  test.each([
    ["window assign 2", { type: "moveWindowToWorkspace", workspace: "2", follow: true }],
    [
      "window assign 2 --window w1 --no-follow",
      { type: "moveWindowToWorkspace", workspace: "2", windowId: "w1", follow: false },
    ],
    [
      "window move position -100 20 --window w1",
      { type: "moveWindow", windowId: "w1", point: { x: -100, y: 20 } },
    ],
    ["window resize 800 600", { type: "resizeWindow", size: { width: 800, height: 600 } }],
    ["window float", { type: "floatWindow" }],
    ["window float --window w1", { type: "floatWindow", windowId: "w1" }],
    ["window float --toggle", { type: "floatWindow", toggle: true }],
    ["window float --toggle --window w1", { type: "floatWindow", windowId: "w1", toggle: true }],
    [
      "workspace move display display:main --workspace 2",
      { type: "moveWorkspaceToDisplay", displayId: "display:main", workspace: "2" },
    ],
    ["workspace move display next", { type: "moveFocusedWorkspaceToNextDisplay" }],
    ["workspace mode floating", { type: "setWorkspaceMode", mode: "floating" }],
    ["workspace retile", { type: "retile" }],
    ["pause --toggle", { type: "togglePause" }],
    ["config reload", { type: "reloadConfig", mode: "delta" }],
    ["config reload full", { type: "reloadConfig", mode: "full" }],
    ["config validate", { type: "validateConfig" }],
    ["window list", { type: "getWindows" }],
    ["window observe --pid 65900", { type: "getWindow", pid: 65900 }],
    ["workspace list", { type: "getWorkspaces" }],
    ["display list", { type: "getDisplays" }],
  ])("CLI, text, keybind and JSON agree for %s", (text, command) => {
    expect(parseCommandText(`wm ${text}`)).toEqual({ ok: true, value: command });
    expect(parseCommandTokens(tokenizeCommandText(text))).toEqual({ ok: true, value: command });
    expect(buildKeybindCommand(text)).toEqual(command);
    expect(decodeCommandSync(JSON.parse(JSON.stringify(command)))).toEqual(command);
  });

  test("preserves shell-tokenized IDs and uses the same text quoting", () => {
    const id = 'window "A" with spaces';
    const tokens = ["window", "assign", "Deep Work", "--window", id, "--no-follow"];
    expect(parseCommandTokens(tokens)).toEqual(
      parseCommandText(tokens.map(quoteCommandToken).join(" ")),
    );
    expect(parseCommandTokens(tokens)).toMatchObject({
      ok: true,
      value: { windowId: id, workspace: "Deep Work" },
    });
  });
  test("accepts flags before positionals and equals-style values", () => {
    expect(parseCommandText("window --window=w1 assign --no-follow 2")).toEqual(
      parseCommandText("window assign 2 --window w1 --no-follow"),
    );
  });
  test.each([
    "window assign 2 --window",
    "window assign 2 --window --no-follow",
    "window assign 2 --window=",
    "window assign 2 --window w1 --window w2",
    "window assign 2 --no-follow --no-follow",
    "window assign 2 --unknown",
    "window assign 2 --__proto__",
    "window assign 2 --no-follow=false",
    "window move left --no-follow",
    "workspace retile --window w1",
    "window resize 0 600",
    "window observe --pid 0",
    "window observe --pid -1",
    "window observe --pid 1.5",
    "window observe --pid 2147483648",
    "window observe --pid abc",
    "window observe --pid 65900 --window w1",
    "window resize NaN 600",
    "window move position Infinity 0",
    "window assign",
    "window assign 2 extra",
  ])("returns structured errors for %s", (text) =>
    expect(parseCommandText(text)).toMatchObject({
      ok: false,
      error: { message: expect.any(String) },
    }),
  );

  test.each([
    "window assign 2; pause",
    "window assign $(cmd)",
    'window assign "unterminated',
    "window assign 2\nresume",
    "window assign 2\\",
  ])("text failures never throw: %s", (text) => {
    expect(() => parseCommandText(text)).not.toThrow();
    expect(parseCommandText(text)).toMatchObject({ ok: false, error: { code: "invalid_text" } });
  });
  test.each([
    "doctor",
    "windows",
    "workspaces",
    "displays",
    "float w1",
    "focus-window w1",
    "workspace move-window 2",
    "window move workspace 2",
    "window probe-limits w1",
    "window frame set 10 20 800 600",
    "window frame set 10 20 800 600 --window w1",
    "reload-config",
    "validate-config",
  ])("rejects removed public spelling %s", (text) => expect(parseCommandText(text).ok).toBe(false));
  test("host commands use the same parser but are not keybind engine actions", () => {
    expect(buildKeybindCommand("window frame set 10 20 800 600 --window w1")).toBeNull();
    expect(parseCommandText("permissions")).toEqual({
      ok: true,
      value: { type: "permissions", action: "status" },
    });
    expect(parseCommandText("permissions request")).toEqual({
      ok: true,
      value: { type: "permissions", action: "request" },
    });
    expect(parseCommandText("service start")).toEqual({
      ok: true,
      value: { type: "service", action: "start" },
    });
    expect(buildKeybindCommand("permissions")).toBeNull();
  });
  test("every guided command path parses", () => {
    const samples = {
      window: "w1",
      workspace: "2",
      display: "display:main",
      coordinate: "-100",
      dimension: "600",
    };
    for (const path of [...commandPaths, ...serviceCommandPaths]) {
      const tokens = path.tokens.map((token) =>
        token.kind === "literal" ? token.value : samples[token.slot],
      );
      expect(parseCommandTokens(tokens), tokens.join(" ")).toMatchObject({ ok: true });
    }
  });
});
