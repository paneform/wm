import { describe, expect, it } from "vitest";
import { railPath, straightRange } from "../src/lib/docs/toc-rail.js";

describe("docs TOC rail", () => {
  it("joins parent and nested headings with one continuous inward bend", () => {
    const points = [
      { x: 2, y: 16 },
      { x: 14, y: 48 },
      { x: 2, y: 80 },
    ];
    expect(railPath(points, 96)).toBe(
      "M 2 0 L 2 16 L 2 26 L 14 38 L 14 48 L 14 58 L 2 70 L 2 80 L 2 96",
    );
    expect(straightRange(points, 1, 32, 64)).toEqual({ start: 40, end: 56 });
  });

  it("keeps a single heading on a straight full-height track", () => {
    const points = [{ x: 2, y: 16 }];
    expect(railPath(points, 32)).toBe("M 2 0 L 2 16 L 2 32");
    expect(straightRange(points, 0, 0, 32)).toEqual({ start: 0, end: 32 });
  });
});
