import { describe, expect, it } from "vitest";
import { heroFeatures, isHeroActionEnabled } from "../src/lib/hero/feature-flags.js";
import { demoTimeline, type DemoCueAction } from "../src/lib/hero/demo-timeline.js";

const monitorActions: DemoCueAction[] = [
  { type: "present", name: "monitor-enter" },
  { type: "present", name: "cable" },
  { type: "present", name: "power-on" },
  { type: "connect-display" },
  { type: "move-workspace-display" },
];

describe("hero feature flags", () => {
  it("disables the external monitor and all of its animation commands by default", () => {
    expect(heroFeatures.secondMonitor).toBe(false);
    for (const action of monitorActions) expect(isHeroActionEnabled(action)).toBe(false);
  });

  it("preserves the complete laptop sequence", () => {
    for (const { action } of demoTimeline) expect(isHeroActionEnabled(action)).toBe(true);
  });

  it("allows monitor commands when the flag is enabled", () => {
    for (const action of monitorActions) {
      expect(isHeroActionEnabled(action, { secondMonitor: true })).toBe(true);
    }
  });
});
