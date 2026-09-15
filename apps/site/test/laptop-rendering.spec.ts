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

it("extends the top bar background across the screen without placing buttons under the notch", async () => {
  const source = await readFile(
    new URL("../src/lib/desktop/DesktopTopBar.svelte", import.meta.url),
    "utf8",
  );
  const barRule = source.match(/\.workspace-bar\s*\{([^}]+)\}/)?.[1];
  const notchedRule = source.match(/\.workspace-bar\.notched\s*\{([^}]+)\}/)?.[1];
  expect(barRule).toMatch(/width:\s*100%\s*;/);
  expect(barRule).toContain("container-type: size");
  expect(source).toContain("var(--workspace-item-height)");
  expect(source).toContain("width: var(--workspace-icon-size)");
  expect(source).toContain("height: var(--workspace-icon-size)");
  expect(notchedRule).toContain("padding-inline-end:");
  expect(notchedRule).not.toMatch(/\bwidth\s*:/);
});

it("caps the dock to the display and sizes its square icons in equal columns", async () => {
  const source = await readFile(
    new URL("../src/lib/desktop/DesktopDock.svelte", import.meta.url),
    "utf8",
  );
  const dockRule = source.match(/\.screen-dock\s*\{([^}]+)\}/)?.[1];
  const buttonRule = source.match(/\bbutton\s*\{([^}]+)\}/)?.[1];
  expect(source).toContain("grid-auto-columns: minmax(0, 1fr)");
  expect(dockRule).toMatch(/max-width:\s*100%\s*;/);
  expect(buttonRule).toMatch(/max-width:\s*100%\s*;/);
  expect(buttonRule).toMatch(/aspect-ratio:\s*1\s*;/);
  expect(source).toContain("width: min(100%, var(--dock-glyph-size))");
});

it("sizes display controls from containers rather than browser viewport units", async () => {
  const [styles, bar, dock] = await Promise.all([
    readFile(new URL("../src/lib/design/global.css", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/desktop/DesktopTopBar.svelte", import.meta.url), "utf8"),
    readFile(new URL("../src/lib/desktop/DesktopDock.svelte", import.meta.url), "utf8"),
  ]);
  const displayRule = styles.match(/\.mac-screen,\s*\.studio-screen\s*\{([^}]+)\}/)?.[1];
  expect(displayRule).toContain("container-type: size");
  expect(displayRule).toContain("--dock-icon-size: min(2.9rem, 6cqw, 10cqh)");
  for (const source of [displayRule, bar, dock]) {
    expect(source).not.toMatch(/[\d.]+v[wh]\b/);
  }
});
