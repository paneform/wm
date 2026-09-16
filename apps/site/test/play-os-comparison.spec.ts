import { readFileSync } from "node:fs";
import { createScenarioSession, parseScenario } from "@paneform/layout-browser";
import { describe, expect, it } from "vitest";
import { decodeScenarioFragment, encodeScenarioFragment } from "../src/lib/play/scenario-url.js";

const preset = parseScenario(
  JSON.parse(
    readFileSync(new URL("../src/lib/play/os-comparison.scenario.json", import.meta.url), "utf8"),
  ),
);

async function replay(os: "none" | { readonly kind: "macos" }) {
  const session = await createScenarioSession({ ...preset, simulation: { os } });
  const frames = [];
  try {
    for (let result = await session.step(); result !== null; result = await session.step()) {
      frames.push(result.state.windows[0]?.frame);
    }
  } finally {
    await session.dispose();
  }
  return frames;
}

describe("OS comparison demo preset", () => {
  it("parses and produces stable, distinct boundary behavior", async () => {
    expect(preset.presentation?.comparison).toEqual({
      primary: {
        label: "CooperativeOS",
        subtext: "allows full window control",
        os: "none",
      },
      secondary: {
        label: "MacOS",
        subtext: "limits window controls",
        os: { kind: "macos" },
      },
    });
    expect(preset.state.wmRunning).toBe(false);

    const [unconstrained, macos] = await Promise.all([replay("none"), replay({ kind: "macos" })]);
    expect(unconstrained).toHaveLength(7);
    expect(macos).toHaveLength(7);
    for (const index of [1, 3, 5]) expect(macos[index]).not.toEqual(unconstrained[index]);
    for (const index of [0, 2, 4, 6]) expect(macos[index]).toEqual(unconstrained[index]);
    expect(await replay("none")).toEqual(unconstrained);
    expect(await replay({ kind: "macos" })).toEqual(macos);
  });

  it("survives share-link encoding without changing the document", async () => {
    const fragment = await encodeScenarioFragment(preset);
    expect(fragment.length).toBeLessThan(2_000);
    expect(await decodeScenarioFragment(fragment)).toEqual(preset);
  });
});
