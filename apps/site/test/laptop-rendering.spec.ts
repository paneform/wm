import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("keeps the screen out of a shared 3D context so Safari can paint and scroll it", async () => {
  const source = await readFile(
    new URL("../src/lib/desktop/Laptop.svelte", import.meta.url),
    "utf8",
  );
  const lidRule = source.match(/\.lid\s*\{([^}]+)\}/)?.[1];
  const laptopRule = source.match(/\.laptop-device\s*\{([^}]+)\}/)?.[1];
  const baseRule = source.match(/\.base-slot\s*\{([^}]+)\}/)?.[1];
  expect(lidRule).toMatch(/transform-style:\s*flat\s*;/);
  expect(laptopRule).toMatch(/transform-style:\s*flat\s*;/);
  expect(lidRule).toContain("var(--lid-pivot-offset)");
  expect(baseRule).toContain("perspective(var(--scene-perspective))");
});

it("keeps the shared laptop root unprojected in both layout callers", async () => {
  const callers = await Promise.all([
    readFile(new URL("../src/lib/hero/Workstation.svelte", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/play/ScenarioStage.svelte", import.meta.url), "utf8"),
  ]);
  for (const source of callers) {
    expect(source).not.toContain("perspective(");
    expect(source).not.toContain("rotateX(");
  }
  expect(callers[1]).toContain("--laptop-pivot: 1");
});
