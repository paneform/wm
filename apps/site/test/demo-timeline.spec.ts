import { describe, expect, it } from "vitest";

import {
  DEMO_DURATION,
  demoTimeline,
  validateDemoTimeline,
} from "../src/lib/hero/demo-timeline.js";
import { tokens } from "../src/lib/design/tokens.js";

describe("hero demo timeline", () => {
  it("is contiguous and ends at exactly 30 seconds", () => {
    expect(() => validateDemoTimeline()).not.toThrow();
    expect(demoTimeline.at(-1)?.end).toBe(DEMO_DURATION);
    expect(tokens.timeline.duration).toBe(DEMO_DURATION);
  });

  it("reserves the specified command submission offsets", () => {
    expect(demoTimeline.find(({ id }) => id === "browser")?.triggerOffset).toBe(
      tokens.timeline.dock.submit,
    );
    expect(demoTimeline.find(({ id }) => id === "browser-right")?.triggerOffset).toBe(
      tokens.timeline.threeKeyChord.trigger,
    );
    expect(demoTimeline.find(({ id }) => id === "select-terminal")?.triggerOffset).toBe(
      tokens.timeline.twoKeyChord.trigger,
    );
    expect(demoTimeline.find(({ id }) => id === "terminal-to-t")?.triggerOffset).toBe(
      tokens.timeline.threeKeyChord.trigger,
    );
  });
});
