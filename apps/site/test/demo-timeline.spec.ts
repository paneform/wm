import { describe, expect, it } from "vitest";

import {
  DEMO_DURATION,
  demoTimeline,
  validateDemoTimeline,
} from "../src/lib/hero/demo-timeline.js";
import { tokens } from "../src/lib/design/tokens.js";

describe("hero demo timeline", () => {
  it("is contiguous and ends at exactly 22 seconds", () => {
    expect(() => validateDemoTimeline()).not.toThrow();
    expect(demoTimeline.at(-1)?.end).toBe(DEMO_DURATION);
    expect(tokens.timeline.duration).toBe(DEMO_DURATION);
  });

  it("opens Settings last and hands over shortly after it appears", () => {
    const settings = demoTimeline.at(-2)!;
    expect(settings.action).toEqual({ type: "activate-app", app: "Settings" });
    expect(settings.start).toBe(demoTimeline.find(({ id }) => id === "waitlist-to-w")?.end);
    expect(DEMO_DURATION - settings.start - settings.triggerOffset).toBeLessThan(1000);
    expect(demoTimeline.at(-1)?.action).toEqual({ type: "present", name: "complete" });
  });

  it("reserves the specified command submission offsets", () => {
    expect(demoTimeline.find(({ id }) => id === "waitlist")?.triggerOffset).toBe(
      tokens.timeline.dock.submit,
    );
    expect(demoTimeline.find(({ id }) => id === "editor-left")?.triggerOffset).toBe(
      tokens.timeline.threeKeyChord.trigger,
    );
    expect(demoTimeline.find(({ id }) => id === "select-terminal")?.triggerOffset).toBe(
      tokens.timeline.twoKeyChord.trigger,
    );
    expect(demoTimeline.find(({ id }) => id === "waitlist-to-w")?.triggerOffset).toBe(
      tokens.timeline.threeKeyChord.trigger,
    );
  });
});
