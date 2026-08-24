import { describe, expect, test } from "vitest";
import { Effect, Stream } from "effect";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createFileConfigSource, resolveConfigPath, stripJsonc } from "../src/config-file.ts";
import { buildCommand, parseArgs, USAGE } from "../src/cli-args.ts";

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
