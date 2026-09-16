import type { LayoutScenario, LinkedComparison } from "@paneform/layout-browser";

export const defaultLinkedComparison: LinkedComparison = {
  primary: {
    label: "",
    subtext: "",
    os: "none",
  },
  secondary: {
    label: "",
    subtext: "",
    os: { kind: "macos" },
  },
};

const legacyLinkedComparison: LinkedComparison = {
  primary: { label: "CooperativeOS", subtext: "allows full window control", os: "none" },
  secondary: {
    label: "MacOS",
    subtext: "limits window controls",
    os: { kind: "macos" },
  },
};

export function comparisonForScenario(scenario: LayoutScenario): LinkedComparison | undefined {
  const comparison = scenario.presentation?.comparison;
  if (comparison === undefined) return undefined;
  if (comparison !== "cooperative-macos") return comparison;

  const originalOs = scenario.simulation?.os;
  return originalOs !== undefined && originalOs !== "none"
    ? {
        ...legacyLinkedComparison,
        secondary: { ...legacyLinkedComparison.secondary, os: originalOs },
      }
    : legacyLinkedComparison;
}
