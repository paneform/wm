import { describe, expect, test } from "vitest";
import { directionalNeighbor, type DirectionalCandidate } from "../src/direction.ts";

// Pure directional neighbor ranking — bean wm-pmys. Deterministic rules:
// strict half-plane, primary-axis gap → orthogonal distance → stable order;
// edge wrap = farthest opposite primary edge.

const at = (id: string, x: number, y: number): DirectionalCandidate => ({ id, x, y });

const neighborOf = (
  direction: "left" | "right" | "up" | "down",
  origin: { x: number; y: number },
  candidates: DirectionalCandidate[],
): string | null => directionalNeighbor({ direction, origin, candidates });

describe("directionalNeighbor — forward half-plane", () => {
  test("left picks the nearest candidate on the primary axis", () => {
    expect(
      neighborOf("left", { x: 500, y: 300 }, [at("far", 100, 300), at("near", 400, 300)]),
    ).toBe("near");
  });

  test("right/up/down each resolve along their axis", () => {
    const candidates = [at("l", 100, 300), at("r", 900, 300), at("u", 500, 50), at("d", 500, 800)];
    expect(neighborOf("right", { x: 500, y: 300 }, candidates)).toBe("r");
    expect(neighborOf("up", { x: 500, y: 300 }, candidates)).toBe("u");
    expect(neighborOf("down", { x: 500, y: 300 }, candidates)).toBe("d");
    expect(neighborOf("left", { x: 500, y: 300 }, candidates)).toBe("l");
  });

  test("primary-axis gap dominates over large orthogonal offsets", () => {
    // The diagonal window is heavily off-axis yet wins: its primary-axis gap
    // (50) is far smaller than the aligned candidate's (200).
    expect(
      neighborOf("left", { x: 500, y: 300 }, [at("diagonal", 450, 800), at("straight", 300, 350)]),
    ).toBe("diagonal");
    expect(
      neighborOf("up", { x: 500, y: 500 }, [at("diagonal", 900, 430), at("straight", 510, 200)]),
    ).toBe("diagonal");
  });

  test("equal primary gap breaks on orthogonal-center distance", () => {
    expect(
      neighborOf("left", { x: 500, y: 300 }, [at("offY", 300, 600), at("aligned", 300, 320)]),
    ).toBe("aligned");
  });

  test("full tie breaks on stable input order, never on coordinates", () => {
    const candidates = [at("second", 100, 300), at("first", 100, 300)];
    expect(neighborOf("left", { x: 500, y: 300 }, candidates)).toBe("second");
    expect(neighborOf("left", { x: 500, y: 300 }, [...candidates].reverse())).toBe("first");
  });

  test("negative coordinates rank correctly", () => {
    expect(
      neighborOf("right", { x: -1000, y: -500 }, [
        at("beyond", -200, -500),
        at("adjacent", -600, -500),
      ]),
    ).toBe("adjacent");
    expect(
      neighborOf("left", { x: -1000, y: -500 }, [
        at("beyond", -1400, -500),
        at("adjacent", -600, -500),
      ]),
    ).toBe("beyond");
  });
});

describe("directionalNeighbor — edge wrap", () => {
  test("at the left edge wrap lands on the farthest right-edge candidate", () => {
    const candidates = [at("middle", 500, 300), at("rightmost", 900, 300)];
    expect(neighborOf("left", { x: 200, y: 300 }, candidates)).toBe("rightmost");
  });

  test("wrap breaks ties by closest orthogonal center then stable order", () => {
    // Pressing UP at the top edge lands on the FARTHEST (bottom-most) window.
    expect(
      neighborOf("up", { x: 500, y: 100 }, [at("highFar", 500, 850), at("lowFar", 500, 900)]),
    ).toBe("lowFar");
    // Equal primary gap on both sides of the ortho axis → stable order decides.
    expect(
      neighborOf("down", { x: 500, y: 900 }, [at("a", 500, 100), at("b", 500, 100)]),
    ).toBe("a");
  });

  test("strict half-plane: an exactly-aligned candidate is not 'forward' and wraps instead", () => {
    // Only candidate shares the origin's x center ⇒ not strictly left ⇒ wrap
    // picks it as farthest (gap 0), which is still deterministic.
    expect(neighborOf("left", { x: 300, y: 300 }, [at("stackedAbove", 300, 100)])).toBe(
      "stackedAbove",
    );
  });
});

describe("directionalNeighbor — degenerate inputs", () => {
  test("no candidates returns null (single-window workspace)", () => {
    expect(neighborOf("left", { x: 0, y: 0 }, [])).toBeNull();
  });
});
