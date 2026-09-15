import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

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
