import { describe, expect, it } from "vitest";
import { measureDock } from "../src/lib/desktop/dock-layout.js";

describe("dock layout", () => {
  it.each([
    [
      "laptop",
      { x: 0, y: 0, width: 1512, height: 982 },
      { x: 0, y: 44, width: 1512, height: 780 },
      760,
      494,
    ],
    [
      "desktop strip",
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 0, y: 32, width: 1920, height: 984 },
      960,
      540,
    ],
  ])("fits the %s reserved strip", (_name, frame, workArea, width, height) => {
    const metrics = measureDock(frame, workArea, width, height, 8)!;
    const strip = Math.floor(
      ((frame.y + frame.height - workArea.y - workArea.height) / frame.height) * height,
    );
    expect(
      metrics.iconSize +
        metrics.padding * 2 +
        metrics.indicatorOffset +
        metrics.bottom +
        metrics.border * 2,
    ).toBeLessThanOrEqual(strip);
    expect(
      metrics.iconSize * 8 + metrics.gap * 7 + metrics.padding * 2 + metrics.border * 2,
    ).toBeLessThanOrEqual(width - 24);
    expect(metrics.iconSize).toBeGreaterThan(0);
    expect(metrics.iconSize).toBeLessThanOrEqual(28);
  });

  it("clamps gracefully for a tiny strip", () => {
    expect(
      measureDock(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 0, width: 100, height: 99 },
        40,
        20,
        8,
      )?.iconSize,
    ).toBe(0);
  });

  it("uses intentional overlay fallback when no strip exists", () => {
    expect(
      measureDock(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 0, y: 0, width: 100, height: 100 },
        100,
        100,
        8,
      ),
    ).toBeNull();
  });
});
