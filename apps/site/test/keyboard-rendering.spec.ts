import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const readComponent = (name: string) =>
  readFile(new URL(`../src/lib/hero/${name}.svelte`, import.meta.url), "utf8");

describe("physical keyboard responsive sizing", () => {
  it("scales labels and hardware geometry from the keyboard inline size", async () => {
    const source = await readComponent("Keyboard");
    const keyboardRule = source.match(/\.keyboard\s*\{([^}]+)\}/)?.[1];
    const keySlotRule = source.match(/\.key-slot\s*\{([^}]+)\}/)?.[1];

    expect(keyboardRule).toContain("container: physical-keyboard / inline-size");
    expect(keySlotRule).toContain("font-size: 3.2cqi");
    expect(keySlotRule).toContain("--key-depth: 0.55cqi");
    expect(keySlotRule).toContain("--key-radius: 0.6cqi");
    expect(keySlotRule).toContain("--key-inset-depth: 0.2cqi");
    expect(keySlotRule).toContain("--key-inset-blur: 0.4cqi");
    expect(keySlotRule).toContain("--key-legend-padding: 0.45cqi");
    expect(keyboardRule).not.toMatch(/\b(?:cqi|vw)\b/);
  });

  it("uses the physical keyboard container for compact legends", async () => {
    const source = await readComponent("KeyboardKeyFace");

    expect(source).toContain("@container physical-keyboard (max-width: 24rem)");
    expect(source).not.toMatch(/@media\s*\(max-width:\s*45rem\)/);
    expect(source).toMatch(/\.key:not\(\.screen\)/);
  });
});
