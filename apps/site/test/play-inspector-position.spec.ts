import { describe, expect, it } from "vitest";
import { positionInspector } from "../src/lib/play/inspector-position.js";

describe("floating inspector position", () => {
  it("prefers the right side on a wide viewport", () => {
    expect(
      positionInspector(
        { left: 100, top: 40, width: 500, height: 400 },
        { width: 1200, height: 800 },
        300,
      ),
    ).toMatchObject({ left: 612, top: 40, width: 312, placement: "right" });
  });

  it("flips left when only the left side fits", () => {
    expect(
      positionInspector(
        { left: 500, top: 40, width: 500, height: 400 },
        { width: 1100, height: 800 },
        300,
      ),
    ).toMatchObject({ left: 176, placement: "left" });
  });

  it("uses a viewport-bounded sheet on narrow screens", () => {
    const result = positionInspector(
      { left: 20, top: 80, width: 320, height: 200 },
      { width: 360, height: 640 },
      500,
    );
    expect(result).toEqual({ left: 20, top: 244, width: 312, maxHeight: 384, placement: "sheet" });
  });

  it("clamps a tall panel within a short viewport", () => {
    const result = positionInspector(
      { left: 20, top: 200, width: 200, height: 100 },
      { width: 800, height: 240 },
      500,
    );
    expect(result.top).toBe(12);
    expect(result.maxHeight).toBe(216);
  });

  it("stays within a panned visual viewport", () => {
    const result = positionInspector(
      { left: 10, top: 10, width: 320, height: 200 },
      { left: 30, top: 100, width: 360, height: 400 },
      500,
    );
    expect(result).toMatchObject({ left: 42, top: 248, maxHeight: 240, placement: "sheet" });
  });
});
