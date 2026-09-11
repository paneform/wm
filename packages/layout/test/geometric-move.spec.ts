import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import { planLayout } from "../src/layout/bsp.ts";
import { moveGeometrically, type GeometricMoveInput } from "../src/layout/geometric-move.ts";
import type { Direction } from "../src/direction.ts";
import type { Frame, WindowId } from "../src/schema.ts";
import type { BspNode, SplitAxis } from "../src/world.ts";

const leaf = (windowId: WindowId): BspNode => ({ kind: "leaf", windowId });
const split = (axis: SplitAxis, ratio: number, first: BspNode, second: BspNode): BspNode => ({
  kind: "split",
  axis,
  ratio,
  first,
  second,
});
const vertical = (ratio: number, first: BspNode, second: BspNode): BspNode =>
  split("vertical", ratio, first, second);
const horizontal = (ratio: number, first: BspNode, second: BspNode): BspNode =>
  split("horizontal", ratio, first, second);
const frame = (x: number, y: number, width: number, height: number): Frame => ({
  x,
  y,
  width,
  height,
});

function framesFor(tree: BspNode, content: Frame, gap = 0): ReadonlyMap<WindowId, Frame> {
  const plan = planLayout({ tree, content, gap, resolve: () => undefined }, ["greedy"]);
  expect(plan.feasible).toBe(true);
  if (!plan.feasible) throw new Error("test fixture has no feasible layout");
  return plan.frames;
}

function move(
  tree: BspNode,
  movedId: WindowId,
  direction: Direction,
  content: Frame,
  options: { frames?: ReadonlyMap<WindowId, Frame>; gap?: number; groups?: boolean } = {},
): BspNode {
  const input: GeometricMoveInput = {
    tree,
    movedId,
    direction,
    frames: options.frames ?? framesFor(tree, content, options.gap),
  };
  if (options.gap !== undefined) input.gap = options.gap;
  if (options.groups !== undefined) input.groups = options.groups;
  return moveGeometrically(input);
}

function expectFrames(
  tree: BspNode,
  content: Frame,
  expected: Record<string, Frame>,
  gap = 0,
): void {
  expect(Object.fromEntries(framesFor(tree, content, gap))).toEqual(expected);
}

function members(tree: BspNode): WindowId[] {
  return tree.kind === "leaf" ? [tree.windowId] : [...members(tree.first), ...members(tree.second)];
}

describe("moveGeometrically confirmed transformations", () => {
  const content = frame(0, 0, 1200, 800);
  const t = vertical(0.5, leaf("A"), horizontal(0.5, leaf("B"), leaf("C")));

  test("B left carries its horizontal divider across the T junction", () => {
    const expected = vertical(0.5, horizontal(0.5, leaf("B"), leaf("A")), leaf("C"));
    const result = move(t, "B", "left", content);

    expect(result).toEqual(expected);
    expectFrames(result, content, {
      B: frame(0, 0, 600, 400),
      A: frame(0, 400, 600, 400),
      C: frame(600, 0, 600, 800),
    });
  });

  test("C left becomes the lower pane beside full-height B", () => {
    const expected = vertical(0.5, horizontal(0.5, leaf("A"), leaf("C")), leaf("B"));
    const result = move(t, "C", "left", content);

    expect(result).toEqual(expected);
    expectFrames(result, content, {
      A: frame(0, 0, 600, 400),
      C: frame(0, 400, 600, 400),
      B: frame(600, 0, 600, 800),
    });
  });

  test("A right leaves full-height B beside C over A", () => {
    const expected = vertical(0.5, leaf("B"), horizontal(0.5, leaf("C"), leaf("A")));
    const result = move(t, "A", "right", content);

    expect(result).toEqual(expected);
    expectFrames(result, content, {
      B: frame(0, 0, 600, 800),
      C: frame(600, 0, 600, 400),
      A: frame(600, 400, 600, 400),
    });
  });

  test("C right rotates into wide B beside A beside C", () => {
    const expected = vertical(0.5, leaf("B"), vertical(0.5, leaf("A"), leaf("C")));
    const result = move(t, "C", "right", content);

    expect(result).toEqual(expected);
    expectFrames(result, content, {
      B: frame(0, 0, 600, 800),
      A: frame(600, 0, 300, 800),
      C: frame(900, 0, 300, 800),
    });
  });

  test("unequal same-axis swap preserves each pane width", () => {
    const tree = vertical(0.5, leaf("AAAA"), vertical(0.75, leaf("BBB"), leaf("C")));
    const expected = vertical(0.5, leaf("AAAA"), vertical(0.25, leaf("C"), leaf("BBB")));
    const result = move(tree, "BBB", "right", frame(0, 0, 800, 800));

    expect(result).toEqual(expected);
    expectFrames(result, frame(0, 0, 800, 800), {
      AAAA: frame(0, 0, 400, 800),
      C: frame(400, 0, 100, 800),
      BBB: frame(500, 0, 300, 800),
    });
  });

  test("same-axis swap excludes the divider gap from its rebuilt ratio", () => {
    const tree = vertical(0.5, leaf("A"), vertical(0.75, leaf("B"), leaf("C")));
    const result = move(tree, "B", "right", frame(0, 0, 810, 800), { gap: 10 });

    expect(result).toEqual(vertical(0.5, leaf("A"), vertical(98 / 390, leaf("C"), leaf("B"))));
    expectFrames(
      result,
      frame(0, 0, 810, 800),
      {
        A: frame(0, 0, 400, 800),
        C: frame(410, 0, 98, 800),
        B: frame(518, 0, 292, 800),
      },
      10,
    );
  });

  test.each([30, 908])("swaps and restores rounding-sensitive widths in %s points", (width) => {
    const first = width === 30 ? 7 : 785;
    const content = frame(0, 0, width, 800);
    const tree = vertical(first / (width - 8), leaf("A"), leaf("B"));
    const original = framesFor(tree, content, 8);
    const swapped = move(tree, "A", "right", content, { gap: 8 });
    const swappedFrames = framesFor(swapped, content, 8);
    expect(swappedFrames.get("A")!.width).toBe(original.get("A")!.width);
    expect(swappedFrames.get("B")!.width).toBe(original.get("B")!.width);
    const restored = move(swapped, "A", "left", content, { gap: 8 });
    expect(framesFor(restored, content, 8)).toEqual(original);
  });

  test("two panes change split axis in movement order", () => {
    const tree = vertical(0.5, leaf("A"), leaf("B"));
    const result = move(tree, "B", "up", frame(0, 0, 600, 800));
    expect(result).toEqual(horizontal(0.5, leaf("B"), leaf("A")));
    expectFrames(result, frame(0, 0, 600, 800), {
      B: frame(0, 0, 600, 400),
      A: frame(0, 400, 600, 400),
    });
  });
});

describe("edge selection and divider preservation", () => {
  test("all four directions are identity no-ops at an unshared outer edge", () => {
    const cases: [BspNode, WindowId, Direction][] = [
      [vertical(0.5, leaf("A"), horizontal(0.5, leaf("B"), leaf("C"))), "A", "left"],
      [horizontal(0.5, leaf("A"), vertical(0.5, leaf("B"), leaf("C"))), "A", "up"],
      [vertical(0.5, horizontal(0.5, leaf("A"), leaf("B")), leaf("C")), "C", "right"],
      [horizontal(0.5, vertical(0.5, leaf("A"), leaf("B")), leaf("C")), "C", "down"],
    ];
    for (const [tree, id, direction] of cases) {
      expect(move(tree, id, direction, frame(0, 0, 1200, 800))).toBe(tree);
    }
  });

  test("equal thirds tie claims the full edge with a 50/50 divider", () => {
    const tree = vertical(1 / 3, leaf("A"), vertical(0.5, leaf("B"), leaf("C")));
    const expected = horizontal(0.5, leaf("B"), vertical(0.5, leaf("A"), leaf("C")));
    const result = move(tree, "B", "up", frame(0, 0, 900, 600));

    expect(result).toEqual(expected);
    expectFrames(result, frame(0, 0, 900, 600), {
      B: frame(0, 0, 900, 300),
      A: frame(0, 300, 450, 300),
      C: frame(450, 300, 450, 300),
    });
  });

  test("edge regrouping excludes gaps and repeated outer moves do not drift", () => {
    const tree = vertical(20 / 61, leaf("A"), vertical(0.5, leaf("B"), leaf("C")));
    const content = frame(0, 0, 930, 600);
    const expected = horizontal(0.5, leaf("B"), vertical(0.5, leaf("A"), leaf("C")));
    const regrouped = move(tree, "B", "up", content, { gap: 15 });

    expect(regrouped).toEqual(expected);
    expect(move(regrouped, "B", "up", content, { gap: 15 })).toBe(regrouped);
    expectFrames(
      regrouped,
      content,
      {
        B: frame(0, 0, 930, 292),
        A: frame(0, 307, 457, 293),
        C: frame(472, 307, 458, 293),
      },
      15,
    );
  });

  test("a non-0.5 T rotation carries both existing divider ratios", () => {
    const tree = vertical(0.4, leaf("A"), horizontal(0.3, leaf("B"), leaf("C")));
    const expected = vertical(0.4, leaf("B"), vertical(0.3, leaf("A"), leaf("C")));
    const result = move(tree, "C", "right", frame(0, 0, 1000, 700));

    expect(result).toEqual(expected);
    expectFrames(result, frame(0, 0, 1000, 700), {
      B: frame(0, 0, 400, 700),
      A: frame(400, 0, 180, 700),
      C: frame(580, 0, 420, 700),
    });
  });

  test("observed area chooses the closest-size edge neighbor", () => {
    const tree = vertical(
      0.4,
      leaf("A"),
      vertical(2 / 3, horizontal(0.5, leaf("B"), leaf("D")), leaf("C")),
    );
    const expected = vertical(
      0.4,
      leaf("A"),
      horizontal(0.5, leaf("B"), vertical(2 / 3, leaf("D"), leaf("C"))),
    );
    const result = move(tree, "B", "up", frame(0, 0, 750, 800));

    expect(result).toEqual(expected);
    expectFrames(result, frame(0, 0, 750, 800), {
      A: frame(0, 0, 300, 800),
      B: frame(300, 0, 450, 400),
      D: frame(300, 400, 300, 400),
      C: frame(600, 400, 150, 400),
    });
  });

  test("group candidates are disabled by default and enabled explicitly", () => {
    const group = horizontal(0.5, leaf("C"), leaf("D"));
    const tree = vertical(0.5, leaf("A"), vertical(0.5, leaf("B"), group));
    const expected = vertical(0.5, leaf("A"), horizontal(0.5, leaf("B"), group));
    const content = frame(0, 0, 1200, 800);

    const ungrouped = vertical(
      0.5,
      leaf("A"),
      horizontal(0.5, leaf("B"), vertical(0.5, leaf("C"), leaf("D"))),
    );
    expect(move(tree, "B", "up", content)).toEqual(ungrouped);
    expect(move(tree, "B", "up", content, { groups: false })).toEqual(ungrouped);
    const grouped = move(tree, "B", "up", content, { groups: true });
    expect(grouped).toEqual(expected);
    expectFrames(grouped, content, {
      A: frame(0, 0, 600, 800),
      B: frame(600, 0, 600, 400),
      C: frame(600, 400, 600, 200),
      D: frame(600, 600, 600, 200),
    });
  });
});

describe("geometric candidate ranking", () => {
  test("a farther direct candidate outranks a closer diagonal candidate", () => {
    const tree = vertical(1 / 3, leaf("A"), vertical(0.5, leaf("B"), leaf("C")));
    const observed = new Map<WindowId, Frame>([
      ["A", frame(0, 0, 100, 100)],
      ["B", frame(120, 101, 100, 100)],
      ["C", frame(300, 50, 100, 100)],
    ]);

    expect(move(tree, "A", "right", frame(0, 0, 1, 1), { frames: observed })).toEqual(
      vertical(1 / 3, leaf("C"), vertical(0.5, leaf("B"), leaf("A"))),
    );
  });

  test("diagonal movement creates a 0.5 orthogonal split in observed order", () => {
    const tree = vertical(0.5, leaf("A"), vertical(0.5, leaf("B"), leaf("C")));
    const observed = new Map<WindowId, Frame>([
      ["A", frame(0, 200, 100, 100)],
      ["B", frame(120, -50, 100, 100)],
      ["C", frame(260, 400, 100, 100)],
    ]);

    expect(move(tree, "A", "right", frame(0, 0, 1, 1), { frames: observed })).toEqual(
      vertical(0.5, horizontal(0.5, leaf("B"), leaf("A")), leaf("C")),
    );
  });

  test("configured gaps and negative coordinates tolerate observed border drift", () => {
    const tree = vertical(0.4, leaf("A"), vertical(0.5, leaf("B"), leaf("C")));
    const observed = new Map<WindowId, Frame>([
      ["A", frame(-900, -40, 392, 800)],
      ["B", frame(-499, -39, 291, 799)],
      ["C", frame(-199, -41, 191, 801)],
    ]);
    const expected = vertical(0.4, leaf("A"), vertical(191 / 482, leaf("C"), leaf("B")));

    expect(move(tree, "B", "right", frame(0, 0, 1, 1), { frames: observed, gap: 9 })).toEqual(
      expected,
    );
  });
});

describe("equivalent visible layouts", () => {
  test("aligned grid reconstruction excludes horizontal and vertical gaps", () => {
    const tree = vertical(
      0.25,
      horizontal(0.5, leaf("A"), leaf("C")),
      horizontal(0.5, leaf("B"), leaf("D")),
    );
    const content = frame(0, 0, 1210, 810);
    const result = move(tree, "A", "right", content, { gap: 10 });

    expectFrames(
      result,
      content,
      {
        B: frame(0, 0, 900, 400),
        A: frame(910, 0, 300, 400),
        C: frame(0, 410, 300, 400),
        D: frame(310, 410, 900, 400),
      },
      10,
    );
    expect(
      Object.fromEntries(framesFor(move(result, "A", "left", content, { gap: 10 }), content, 10)),
    ).toEqual(Object.fromEntries(framesFor(tree, content, 10)));
  });

  test.each([0.25, 0.5])(
    "aligned grid cells swap independently of nesting at ratio %s",
    (ratio) => {
      const rows = horizontal(
        0.5,
        vertical(ratio, leaf("A"), leaf("B")),
        vertical(ratio, leaf("C"), leaf("D")),
      );
      const columns = vertical(
        ratio,
        horizontal(0.5, leaf("A"), leaf("C")),
        horizontal(0.5, leaf("B"), leaf("D")),
      );
      const content = frame(0, 0, 1200, 800);
      for (const tree of [rows, columns]) {
        expectFrames(move(tree, "A", "right", content), content, {
          B: frame(0, 0, 1200 * (1 - ratio), 400),
          A: frame(1200 * (1 - ratio), 0, 1200 * ratio, 400),
          C: frame(0, 400, 1200 * ratio, 400),
          D: frame(1200 * ratio, 400, 1200 * (1 - ratio), 400),
        });
      }
    },
  );

  test("outer T rotation leaves nonadjacent columns unchanged", () => {
    const pair = horizontal(0.5, leaf("B"), leaf("C"));
    const rightNested = vertical(1 / 3, leaf("A"), vertical(0.5, leaf("E"), pair));
    const leftNested = vertical(2 / 3, vertical(0.5, leaf("A"), leaf("E")), pair);
    const content = frame(0, 0, 1200, 800);
    for (const tree of [rightNested, leftNested]) {
      expectFrames(move(tree, "C", "right", content), content, {
        A: frame(0, 0, 400, 800),
        B: frame(400, 0, 400, 800),
        E: frame(800, 0, 200, 800),
        C: frame(1000, 0, 200, 800),
      });
    }
  });

  test("closest-size column pairing does not depend on divider association", () => {
    const rightNested = vertical(0.5, leaf("A"), vertical(0.5, leaf("B"), leaf("C")));
    const leftNested = vertical(0.75, vertical(2 / 3, leaf("A"), leaf("B")), leaf("C"));
    const content = frame(0, 0, 1200, 800);
    for (const tree of [rightNested, leftNested]) {
      expectFrames(move(tree, "B", "up", content), content, {
        A: frame(0, 0, 600, 800),
        B: frame(600, 0, 600, 400),
        C: frame(600, 400, 600, 400),
      });
    }
  });
});

describe("planner safety properties", () => {
  test("incomplete, invalid, or absent observations return the original tree", () => {
    const tree = vertical(0.5, leaf("A"), leaf("B"));
    const invalidCases: ReadonlyMap<WindowId, Frame>[] = [
      new Map([["A", frame(0, 0, 100, 100)]]),
      new Map([
        ["A", frame(0, 0, 100, 100)],
        ["B", frame(100, 0, 0, 100)],
      ]),
      new Map([
        ["A", frame(0, 0, 100, 100)],
        ["B", frame(Number.NaN, 0, 100, 100)],
      ]),
    ];

    for (const frames of invalidCases) {
      expect(moveGeometrically({ tree, movedId: "A", direction: "right", frames })).toBe(tree);
    }
    expect(
      moveGeometrically({
        tree,
        movedId: "missing",
        direction: "right",
        frames: framesFor(tree, frame(0, 0, 200, 100)),
      }),
    ).toBe(tree);
  });

  test("preserves membership, does not mutate inputs, and is deterministic", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fc.double({ min: 0.05, max: 0.95, noNaN: true }),
        fc.constantFrom<Direction>("left", "right", "up", "down"),
        fc.constantFrom<WindowId>("A", "B", "C"),
        (outerRatio, innerRatio, direction, movedId) => {
          const tree = vertical(
            outerRatio,
            leaf("A"),
            horizontal(innerRatio, leaf("B"), leaf("C")),
          );
          const frames = framesFor(tree, frame(-120, -80, 1000, 700), 7);
          const treeBefore = structuredClone(tree);
          const framesBefore = structuredClone([...frames]);
          const input = { tree, movedId, direction, frames, gap: 7 };

          const first = moveGeometrically(input);
          const second = moveGeometrically(input);

          expect(first).toEqual(second);
          expect([...members(first)].sort()).toEqual(["A", "B", "C"]);
          expect(tree).toEqual(treeBefore);
          expect([...frames]).toEqual(framesBefore);
        },
      ),
      { seed: 0x6f707770, numRuns: 100 },
    );
  });
});
