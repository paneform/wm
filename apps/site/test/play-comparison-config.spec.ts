import type { LayoutScenario, LinkedComparison } from "@paneform/layout-browser";
import { describe, expect, it } from "vitest";
import {
  comparisonForScenario,
  defaultLinkedComparison,
} from "../src/lib/play/comparison-config.js";

const state = { topology: [], windows: [] };

describe("comparison configuration", () => {
  it("resolves the legacy comparison and preserves a macOS override", () => {
    const scenario: LayoutScenario = {
      presentation: { comparison: "cooperative-macos" },
      simulation: { os: { kind: "macos", bottomVisible: 48 } },
      state,
    };
    expect(comparisonForScenario(scenario)).toEqual({
      primary: {
        label: "CooperativeOS",
        subtext: "allows full window control",
        os: "none",
      },
      secondary: {
        label: "MacOS",
        subtext: "limits window controls",
        os: { kind: "macos", bottomVisible: 48 },
      },
    });
  });

  it("keeps new linked comparison defaults unlabeled", () => {
    expect(defaultLinkedComparison).toEqual({
      primary: { label: "", subtext: "", os: "none" },
      secondary: { label: "", subtext: "", os: { kind: "macos" } },
    });
  });

  it("returns an object comparison unchanged", () => {
    const comparison: LinkedComparison = {
      primary: { label: "mac first", subtext: "bounded", os: { kind: "macos" } },
      secondary: { label: "free second", subtext: "unbounded", os: "none" },
    };
    expect(comparisonForScenario({ presentation: { comparison }, state })).toBe(comparison);
  });

  it("returns undefined without comparison metadata", () => {
    expect(comparisonForScenario({ state })).toBeUndefined();
  });
});
