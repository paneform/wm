import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { render } from "svelte/server";
import SettingsShortcuts from "../src/lib/hero/SettingsShortcuts.svelte";

it("stacks each shortcut alternative and keeps the table shrinkable", async () => {
  const source = await readFile(
    new URL("../src/lib/hero/SettingsShortcuts.svelte", import.meta.url),
    "utf8",
  );

  expect(source).toContain("{#each row.bindings as binding}");
  expect(source).toContain("[workspaceKeys[0], workspaceKeys[1]]");
  expect(source).toContain("[workspaceKeys[2], workspaceKeys[3]]");
  expect(source).toContain("flex-direction: column");
  expect(source).toContain("table-layout: fixed");
  expect(source).toContain("overflow-y: auto");
  expect(source).not.toContain("overflow: auto");
  expect(source).not.toContain("width: max-content");
});

it("renders the hero shortcut table when keybinds are omitted", () => {
  const { body } = render(SettingsShortcuts);
  expect(body).toContain("focus workspace");
  expect(body).toContain("move workspace to next display");
});

it("renders configured chords and commands instead of hero defaults", () => {
  const { body } = render(SettingsShortcuts, {
    props: { keybinds: { "command return": "workspace focus code" } },
  });
  expect(body).toContain("command return");
  expect(body).toContain("workspace focus code");
  expect(body).toContain("Reveal and focus a workspace.");
  expect(body).not.toContain("focus workspace");
});

it("keeps an explicitly empty keybind record empty", () => {
  const { body } = render(SettingsShortcuts, { props: { keybinds: {} } });
  expect(body).toContain("No keyboard shortcuts configured.");
  expect(body).not.toContain("focus workspace");
});

it("labels unsupported configured bindings", () => {
  const { body } = render(SettingsShortcuts, {
    props: { keybinds: { "hyper moon": "launch everything" } },
  });
  expect(body).toContain("hyper moon");
  expect(body).toContain("launch everything");
  expect(body).toContain("Unsupported in the playground: unsupported key chord");
});

it("recognizes Settings stage windows by bundle ID with a title fallback", async () => {
  const source = await readFile(
    new URL("../src/lib/play/ScenarioStage.svelte", import.meta.url),
    "utf8",
  );
  expect(source).toContain('source?.bundleId === "com.apple.systempreferences"');
  expect(source).toContain('source?.bundleId === undefined && window.title === "Settings"');
  expect(source).toContain("<SettingsShortcuts {keybinds} />");
  expect(source).toContain("contentForWindow=");
});
