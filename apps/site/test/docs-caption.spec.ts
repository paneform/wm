import { describe, expect, it } from "vitest";
import {
  DEMO_CAPTION_COLUMNS,
  DEMO_CAPTION_MAX_LENGTH,
  formatDemoCaption,
} from "../src/lib/docs/demo-caption.js";
import { parseDocsScenario } from "../src/lib/docs/demo-data.js";
import { scenarioFiles } from "../src/lib/docs/scenario-files.js";

describe("docs caption budget", () => {
  it("wraps at word boundaries into two fixed-width lines", () => {
    expect(DEMO_CAPTION_MAX_LENGTH).toBe(DEMO_CAPTION_COLUMNS * 2);
    expect(formatDemoCaption("The focused window swaps places with its left neighbor.")).toBe(
      "The focused window swaps places\nwith its left neighbor.",
    );
    expect(formatDemoCaption("Focus moves left.")).toBe("Focus moves left.");
  });

  it("rejects excessive length and text that word-wraps to a third line", () => {
    expect(() => formatDemoCaption("a".repeat(65))).toThrow("exceeds 64 characters");
    expect(() =>
      formatDemoCaption(["a".repeat(22), "b".repeat(22), "c".repeat(18)].join(" ")),
    ).toThrow("must fit two");
    expect(() => formatDemoCaption("a".repeat(33))).toThrow("word longer");
  });

  it("rejects hard line breaks and empty captions", () => {
    expect(() => formatDemoCaption("before\nafter")).toThrow("single-line text");
    expect(() => formatDemoCaption("   ")).toThrow("nonempty");
  });

  it("enforces the limit when loading docs scenario data", () => {
    const source = scenarioFiles["move-swap.json"];
    const invalid = { ...source, steps: [{ command: "state", caption: "a".repeat(65) }] };
    expect(() => parseDocsScenario(invalid)).toThrow("Step 1 caption exceeds 64 characters");
  });
});
