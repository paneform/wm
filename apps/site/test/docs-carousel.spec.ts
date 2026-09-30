import { describe, expect, it } from "vitest";
import { carouselSelection, carouselTarget } from "../src/lib/docs/carousel.js";

describe("demo carousel scrolling", () => {
  const cards = Array.from({ length: 5 }, (_, index) => ({ left: 4 + index * 312, width: 304 }));
  const view = { left: 0, width: 664, contentWidth: 1560 };

  it("keeps cards already fully visible stationary", () => {
    expect(carouselTarget(view, cards[0]!)).toBe(0);
    expect(carouselTarget(view, cards[1]!)).toBe(0);
  });

  it("reveals later cards and clamps the final card to the end of the track", () => {
    expect(carouselTarget(view, cards[2]!)).toBe(628);
    expect(carouselTarget(view, cards[4]!)).toBe(896);
    expect(carouselTarget({ ...view, left: 896 }, cards[0]!)).toBe(4);
  });

  it("selects the leading snapped card or the final end-stop card", () => {
    expect(carouselSelection({ ...view, left: 316 }, cards)).toBe(1);
    expect(carouselSelection({ ...view, left: 896 }, cards)).toBe(4);
    expect(carouselSelection(view, cards)).toBe(0);
  });

  it("handles one example and mobile-width viewports", () => {
    expect(carouselTarget({ left: 0, width: 320, contentWidth: 312 }, cards[0]!)).toBe(0);
    expect(carouselSelection({ left: 0, width: 320, contentWidth: 312 }, cards.slice(0, 1))).toBe(
      0,
    );
    expect(
      carouselTarget({ left: 0, width: 280, contentWidth: 1310 }, { left: 1052, width: 254 }),
    ).toBe(1030);
  });
});
