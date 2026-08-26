import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFileConfigSource, resolveConfigPath, stripJsonc } from "../src/config-file.ts";
import { buildCommand, buildKeybindCommand, parseArgs, USAGE } from "../src/cli-args.ts";
import { legacySketchybarSnapshot } from "../src/sketchybar.ts";
import type { StateSnapshot } from "@wm/engine";

describe("stripJsonc", () => {
  test("removes comments and trailing commas", () => {
    const jsonc = `{
      // line comment
      /* block
         comment */
      "gap": 8, // trailing comment
      "workspaces": ["a", "b",],
    }`;
    expect(JSON.parse(stripJsonc(jsonc))).toEqual({ gap: 8, workspaces: ["a", "b"] });
  });

  test("keeps comment-like content inside strings", () => {
    expect(JSON.parse(stripJsonc(`{ "url": "http://x//y" }`))).toEqual({ url: "http://x//y" });
  });
});

describe("SketchyBar compatibility", () => {
  test("groups workspaces by stable display intent and preserves native display ids", () => {
    const snapshot = {
      health: "healthy",
      focusedWorkspace: "T",
      topology: [
        { id: "display:built-in", nativeId: "1", primary: true },
        { id: "display:dell", nativeId: "4", primary: false },
      ],
      windows: [{ id: "w1", executablePath: "/Applications/Ghostty.app/Contents/MacOS/ghostty" }],
      workspaces: [
        { name: "1", members: [], floating: [], preferredDisplay: "display:built-in", visibleOnDisplay: null, pinnedDisplayOverride: null },
        { name: "T", members: ["w1"], floating: [], preferredDisplay: "display:dell", visibleOnDisplay: "display:dell", pinnedDisplayOverride: null },
      ],
    } as unknown as StateSnapshot;

    expect(legacySketchybarSnapshot(snapshot)).toMatchObject({
      focused_workspace_name: "T",
      displays: [
        { identifiers: { cg_direct_display_id: "1" }, workspaces: [{ name: "1" }] },
        {
          identifiers: { cg_direct_display_id: "4" },
          workspaces: [{ name: "T", windows: [{ app_name: "ghostty" }] }],
        },
      ],
    });
  });
});

describe("resolveConfigPath", () => {
  test("WM_CONFIG wins, then XDG, then default home", () => {
    expect(resolveConfigPath({ WM_CONFIG: "/tmp/a.jsonc" })).toBe("/tmp/a.jsonc");
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/h" })).toBe("/xdg/wm/config.jsonc");
    expect(resolveConfigPath({ HOME: "/h" })).toBe("/h/.config/wm/config.jsonc");
  });
});

describe("createFileConfigSource", () => {
  test("load parses JSONC and changes() fires after debounce", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-config-"));
    const file = path.join(dir, "config.jsonc");
    fs.writeFileSync(file, '{ "gap": 8 }\n');
    const source = createFileConfigSource(file);

    const loaded = await Effect.runPromise(source.load());
    expect(loaded).toEqual({ gap: 8 });

    let changes = 0;
    const fiber = Effect.runFork(
      Stream.runForEach(Stream.take(source.changes(), 1), () => Effect.sync(() => changes++)),
    );
    await new Promise((r) => setTimeout(r, 20));
    fs.writeFileSync(file, '{ "gap": 12 }\n');
    await new Promise((r) => setTimeout(r, 400));
    await Effect.runPromise(fiber.await.pipe(Effect.orDie));
    expect(changes).toBe(1);
    expect(await Effect.runPromise(source.load())).toEqual({ gap: 12 });

    fs.rmSync(dir, { recursive: true, force: true });
  }, 5000);
});

describe("parseArgs / buildCommand", () => {
  test("human-friendly keybind actions map directly to engine commands", () => {
    expect(buildKeybindCommand("window move workspace S")).toEqual({
      type: "moveFocusedWindowToWorkspace",
      workspace: "S",
    });
    expect(buildKeybindCommand("workspace focus S")).toEqual({
      type: "focusWorkspace",
      name: "S",
    });
    expect(buildKeybindCommand("workspace pause --toggle")).toEqual({ type: "togglePause" });
    expect(buildKeybindCommand("not a command")).toBeNull();
  });
  test("--help short-circuits to usage", () => {
    const parsed = parseArgs(["--help"]);
    expect(parsed.help).toBe(true);
    expect(parsed.command).toBeNull();
    expect(USAGE).toContain("wm serve");
  });

  test("verbs map onto engine commands", () => {
    expect(buildCommand("state", [])).toEqual({ type: "getState" });
    expect(buildCommand("focus-window", ["window:cg:1"])).toEqual({
      type: "focusWindow",
      windowId: "window:cg:1",
    });
    expect(buildCommand("move-window", ["w1", "10", "20"])).toEqual({
      type: "moveWindow",
      windowId: "w1",
      point: { x: 10, y: 20 },
    });
    expect(buildCommand("observe-window", ["window:cg:1"])).toEqual({
      type: "getWindow",
      windowId: "window:cg:1",
    });
    expect(buildCommand("window", ["probe-limits", "window:cg:1"])).toEqual({
      type: "probeWindowLimits",
      windowId: "window:cg:1",
    });
    expect(buildCommand("debug-frame", ["set", "w1", "10", "20", "800", "600"])).toEqual({
      type: "setWindowFrame",
      windowId: "w1",
      frame: { x: 10, y: 20, width: 800, height: 600 },
    });
    expect(buildCommand("debug-frame", ["set", "w1", "10", "20", "0", "600"])).toBeNull();
    expect(buildCommand("debug-frame", ["set", "w1", "x", "20", "800", "600"])).toBeNull();
    expect(buildCommand("workspace", ["focus", "dev"])).toEqual({
      type: "focusWorkspace",
      name: "dev",
    });
    expect(buildCommand("reload-config", ["full"])).toEqual({
      type: "reloadConfig",
      mode: "full",
    });
    expect(buildCommand("unknown-verb", [])).toBeNull();
    expect(buildCommand("float", [])).toBeNull(); // missing id
  });

  test("serve flag routes to daemon mode", () => {
    const parsed = parseArgs(["serve", "--port", "9999"]);
    expect(parsed.serve).toBe(true);
    expect(parsed.flags["port"]).toBe("9999");
    expect(parsed.command).toBeNull();
  });
});

describe("skhd hotkey syntax parity (bean wm-pmys)", () => {
  test("`wm workspace pause --toggle` maps to togglePause", () => {
    // Exact skhdrc line: `wm workspace pause --toggle`
    const parsed = parseArgs(["workspace", "pause", "--toggle"]);
    expect(parsed.command).toEqual({ type: "togglePause" });
    expect(buildCommand("workspace", ["pause"], {})).toBeNull(); // requires --toggle
  });

  test("`wm workspace move-window NAME` moves the FOCUSED window", () => {
    for (const name of ["1", "9", "A", "W"]) {
      expect(parseArgs(["workspace", "move-window", name]).command).toEqual({
        type: "moveFocusedWindowToWorkspace",
        workspace: name,
      });
    }
  });

  test("`wm workspace move-window ID NAME` keeps the explicit-ID form", () => {
    expect(parseArgs(["workspace", "move-window", "win:7", "dev"]).command).toEqual({
      type: "moveWindowToWorkspace",
      windowId: "win:7",
      workspace: "dev",
    });
    expect(buildCommand("workspace", ["move-window"], {})).toBeNull();
  });

  test("`wm workspace move next` maps to moveFocusedWorkspaceToNextDisplay", () => {
    expect(parseArgs(["workspace", "move", "next"]).command).toEqual({
      type: "moveFocusedWorkspaceToNextDisplay",
    });
    expect(buildCommand("workspace", ["move", "prev"], {})).toBeNull();
    // The explicit display form is unaffected.
    expect(parseArgs(["workspace", "move-display", "dev", "display:x"]).command).toEqual({
      type: "moveWorkspaceToDisplay",
      workspace: "dev",
      displayId: "display:x",
    });
  });

  test("workspace focus cannot fall through to workspace movement", () => {
    for (const name of ["T", "M", "1", "next", "move"]) {
      expect(parseArgs(["workspace", "focus", name]).command).toEqual({
        type: "focusWorkspace",
        name,
      });
    }
    expect(parseArgs(["workspace", "focus", "T", "next"]).command).toBeNull();
    expect(parseArgs(["workspace", "move", "T"]).command).toBeNull();
  });

  test("`wm window focus DIR` maps onto focusDirection for all four directions", () => {
    for (const direction of ["left", "right", "up", "down"] as const) {
      expect(buildCommand("window", ["focus", direction])).toEqual({
        type: "focusDirection",
        direction,
      });
      expect(parseArgs(["window", "focus", direction]).command).toEqual({
        type: "focusDirection",
        direction,
      });
    }
  });

  test("`wm window move DIR` maps onto moveDirection for all four directions", () => {
    for (const direction of ["left", "right", "up", "down"] as const) {
      expect(buildCommand("window", ["move", direction])).toEqual({
        type: "moveDirection",
        direction,
      });
      expect(parseArgs(["window", "move", direction]).command).toEqual({
        type: "moveDirection",
        direction,
      });
    }
  });

  test("malformed directional invocations return null", () => {
    expect(parseArgs(["window", "focus", "diagonal"]).command).toBeNull();
    expect(parseArgs(["window", "focus"]).command).toBeNull();
    expect(parseArgs(["window"]).command).toBeNull();
    expect(parseArgs(["window", "resize", "left"]).command).toBeNull();
    expect(buildCommand("window", ["focus", "LEFT"], {})).toBeNull(); // case-sensitive
  });

  test("excess arguments are rejected for every new form (exact arity)", () => {
    expect(parseArgs(["window", "focus", "left", "now"]).command).toBeNull();
    expect(parseArgs(["window", "move", "up", "down"]).command).toBeNull();
    expect(parseArgs(["workspace", "pause", "--toggle", "extra"]).command).toBeNull();
    expect(parseArgs(["workspace", "move", "next", "display:x"]).command).toBeNull();
    // Two positionals ARE the explicit ID form (arity-disambiguated); a third
    // positional is excess and rejected.
    expect(parseArgs(["workspace", "move-window", "win:1", "dev", "extra"]).command).toBeNull();
    // Valid forms still parse with identical tokens.
    expect(parseArgs(["window", "focus", "left"]).command).toEqual({
      type: "focusDirection",
      direction: "left",
    });
    expect(parseArgs(["workspace", "move-window", "win:1", "dev"]).command).toEqual({
      type: "moveWindowToWorkspace",
      windowId: "win:1",
      workspace: "dev",
    });
  });
});
