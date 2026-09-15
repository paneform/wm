import { describe, expect, it } from "vitest";
import { resizeFrame, type ResizeEdge } from "../src/lib/hero/resize-frame.js";

describe("resize frame", () => {
  const frame = { x: -500, y: 100, width: 600, height: 400 };

  it.each<[ResizeEdge, number, number, number, number]>([
    ["n", -500, 120, 600, 380],
    ["s", -500, 100, 600, 420],
    ["e", -500, 100, 630, 400],
    ["w", -470, 100, 570, 400],
    ["ne", -500, 120, 630, 380],
    ["nw", -470, 120, 570, 380],
    ["se", -500, 100, 630, 420],
    ["sw", -470, 100, 570, 420],
  ])("resizes %s while anchoring the opposite sides", (edge, x, y, width, height) => {
    expect(resizeFrame(frame, edge, 30, 20)).toEqual({ x, y, width, height });
  });

  it("clamps dimensions without moving the opposite corner", () => {
    expect(resizeFrame(frame, "nw", 1000, 1000)).toEqual({
      x: -60,
      y: 400,
      width: 160,
      height: 100,
    });
    expect(resizeFrame(frame, "se", -1000, -1000)).toEqual({
      x: -500,
      y: 100,
      width: 160,
      height: 100,
    });
  });
});
