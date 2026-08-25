import { describe, expect, test } from "vitest";
import {
  aggregateBounds,
  axisForFrame,
  constraintsResolver,
  contentRect,
  insertLeaf,
  isValidRatio,
  memberIds,
  partitionLengths,
  planLayout,
  removeLeaf,
} from "../src/layout/bsp.ts";
import { BSP_DEFAULT_GAP } from "../src/constants.ts";
import type { BspNode, SplitAxis } from "../src/world.ts";
import type { Constraints, Frame, WindowId } from "../src/schema.ts";
import { makeDisplay } from "./helpers/fake-platform.ts";

const leaf = (windowId: WindowId): BspNode => ({ kind: "leaf", windowId });

const split = (
  axis: SplitAxis,
  ratio: number,
  first: BspNode,
  second: BspNode,
): BspNode => ({ kind: "split", axis, ratio, first, second });

const frame = (x: number, y: number, width: number, height: number): Frame => ({
  x,
  y,
  width,
  height,
});

const constraintMap = (entries: Record<WindowId, Constraints>): (id: WindowId) => Constraints | undefined =>
  (id) => entries[id];

describe("BSP tree shape", () => {
  describe("insertLeaf", () => {
    test("splits a square leaf with a vertical divider (longest-dim tie ⇒ vertical)", () => {
      const tree = insertLeaf(leaf("a"), "a", "b", frame(0, 0, 600, 600));
      expect(tree).toEqual({
        kind: "split",
        axis: "vertical",
        ratio: 0.5,
        first: leaf("a"),
        second: leaf("b"),
      });
    });

    test("wide frames split vertically, tall frames horizontally", () => {
      const wide = insertLeaf(leaf("a"), "a", "b", frame(0, 0, 800, 400));
      expect(wide?.kind === "split" && wide.axis).toBe("vertical");
      const tall = insertLeaf(leaf("a"), "a", "b", frame(0, 0, 400, 800));
      expect(tall?.kind === "split" && tall.axis).toBe("horizontal");
    });

    test("existing window stays first, new window is second child at ratio 0.5", () => {
      const tree = insertLeaf(leaf("focused"), "focused", "newcomer", frame(0, 0, 1000, 500));
      expect(tree).toEqual({
        kind: "split",
        axis: "vertical",
        ratio: 0.5,
        first: leaf("focused"),
        second: leaf("newcomer"),
      });
    });

    test("insertion into a nested tree targets the given leaf and preserves the rest", () => {
      const tree = split("vertical", 0.5, leaf("a"), split("horizontal", 0.6, leaf("b"), leaf("c")));
      const next = insertLeaf(tree, "b", "d", frame(0, 0, 400, 800));
      expect(next).toEqual(
        split("vertical", 0.5, leaf("a"), split("horizontal", 0.6, split("horizontal", 0.5, leaf("b"), leaf("d")), leaf("c"))),
      );
      expect(memberIds(next!)).toEqual(["a", "b", "d", "c"]);
    });

    test("returns null when the target leaf does not exist", () => {
      expect(insertLeaf(split("vertical", 0.5, leaf("a"), leaf("b")), "missing", "x")).toBeNull();
    });
  });

  describe("removeLeaf", () => {
    test("promotes the sibling subtree wholesale, preserving nested ratios", () => {
      const inner = split("horizontal", 0.72, leaf("b"), leaf("c"));
      const tree = split("vertical", 0.35, leaf("a"), inner);
      expect(removeLeaf(tree, "a")).toEqual(split("horizontal", 0.72, leaf("b"), leaf("c")));
    });

    test("removing an inner leaf keeps the outer ratio and promotes only its sibling", () => {
      const tree = split("vertical", 0.35, split("horizontal", 0.72, leaf("a"), leaf("b")), leaf("c"));
      expect(removeLeaf(tree, "a")).toEqual(split("vertical", 0.35, leaf("b"), leaf("c")));
    });

    test("removing the last leaf empties the tree; removing an absent id changes nothing", () => {
      expect(removeLeaf(leaf("only"), "only")).toBeNull();
      const tree = split("vertical", 0.5, leaf("a"), leaf("b"));
      expect(memberIds(removeLeaf(tree, "absent")!)).toEqual(["a", "b"]);
    });
  });
});

describe("BSP two-pane solve", () => {
  test("preferred length = floor(available · ratio); second pane offset += gap; shared edge rounded once", () => {
    const result = partitionLengths(1005, BSP_DEFAULT_GAP, 0.5, {}, {});
    expect(result).toEqual({ first: 502, second: 495, feasible: true });

    const plan = planLayout({
      tree: split("vertical", 0.5, leaf("a"), leaf("b")),
      content: frame(10, 20, 1005, 500),
      resolve: () => undefined,
    });
    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    const a = plan.frames.get("a")!;
    const b = plan.frames.get("b")!;
    expect(a.width).toBe(502);
    expect(b.x).toBe(a.x + a.width + BSP_DEFAULT_GAP);
    expect(b.x - (a.x + a.width)).toBe(BSP_DEFAULT_GAP);
    expect(a.width + BSP_DEFAULT_GAP + b.width).toBe(1005);
  });

  test("min-size-aware solve: 1512-wide content, gap 8, ratio 0.5, one window minWidth 800 ⇒ constrained pane 800, peer 704, boundary at x=808", () => {
    const unit = partitionLengths(1512, BSP_DEFAULT_GAP, 0.5, { min: 800 }, {});
    expect(unit).toEqual({ first: 800, second: 704, feasible: true });

    const display = makeDisplay();
    const plan = planLayout({
      tree: split("vertical", 0.5, leaf("capped"), leaf("peer")),
      content: contentRect(display),
      gap: BSP_DEFAULT_GAP,
      resolve: constraintsResolver(constraintMap({ capped: { minWidth: 800 } })),
    });
    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    expect(plan.policy).toBe("greedy");
    expect(plan.frames.get("capped")).toEqual(frame(0, 38, 800, 944));
    expect(plan.frames.get("peer")).toEqual(frame(808, 38, 704, 944));
  });

  test("mirrored case: minWidth on the second pane ⇒ [704, 800] with boundary at x=712", () => {
    const unit = partitionLengths(1512, BSP_DEFAULT_GAP, 0.5, {}, { min: 800 });
    expect(unit).toEqual({ first: 704, second: 800, feasible: true });

    const plan = planLayout({
      tree: split("vertical", 0.5, leaf("peer"), leaf("capped")),
      content: frame(0, 0, 1512, 944),
      gap: BSP_DEFAULT_GAP,
      resolve: constraintsResolver(constraintMap({ capped: { minWidth: 800 } })),
    });
    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    expect(plan.frames.get("peer")).toMatchObject({ x: 0, width: 704 });
    expect(plan.frames.get("capped")).toMatchObject({ x: 712, width: 800 });
  });

  test("surplus above a maximum flows to the peer (723/781)", () => {
    const result = partitionLengths(1512, BSP_DEFAULT_GAP, 0.5, { max: 723 }, {});
    expect(result).toEqual({ first: 723, second: 781, feasible: true });
    expect(result.first + BSP_DEFAULT_GAP + result.second).toBe(1512);
  });

  test("infeasible ranges collapse safely instead of producing negative panes", () => {
    const result = partitionLengths(100, 8, 0.5, { min: 90 }, { min: 90 });
    expect(result.feasible).toBe(false);
  });

  test("a single leaf is infeasible when its minimum exceeds the work area", () => {
    expect(
      planLayout(
        {
          tree: leaf("wide"),
          content: frame(0, 0, 1512, 950),
          resolve: constraintsResolver(constraintMap({ wide: { minWidth: 1600 } })),
        },
        ["greedy"],
      ),
    ).toEqual({ feasible: false });
  });

  test("contained overlap honors three infeasible nominal minima", () => {
    const plan = planLayout({
      tree: split(
        "vertical",
        0.5,
        leaf("spotify"),
        split("vertical", 0.5, leaf("docker"), leaf("chatgpt")),
      ),
      content: frame(0, 32, 1512, 950),
      gap: 0,
      resolve: constraintsResolver(
        constraintMap({
          spotify: { minWidth: 800 },
          docker: { minWidth: 940 },
          chatgpt: { minWidth: 480 },
        }),
      ),
    });

    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    expect(plan.policy).toBe("overlap");
    expect([...plan.frames]).toEqual([
      ["spotify", frame(0, 32, 800, 950)],
      ["docker", frame(572, 32, 940, 950)],
      ["chatgpt", frame(1032, 32, 480, 950)],
    ]);
  });

  test("overlap rejects contradictory and individually oversized bounds", () => {
    const input = {
      tree: leaf("wide"),
      content: frame(0, 32, 1512, 950),
      resolve: constraintsResolver(constraintMap({ wide: { minWidth: 1600 } })),
    };
    expect(planLayout(input, ["overlap"])).toEqual({ feasible: false });
    const fallback = planLayout(input);
    expect(fallback.feasible && fallback.policy).toBe("overflow");
    if (fallback.feasible) expect(fallback.frames.get("wide")?.width).toBe(1600);
    expect(
      planLayout(
        {
          ...input,
          resolve: constraintsResolver(
            constraintMap({ wide: { minWidth: 900, maxWidth: 800 } }),
          ),
        },
        ["overlap"],
      ),
    ).toEqual({ feasible: false });
  });
});

describe("subtree aggregate bounds", () => {
  const resolve = constraintsResolver(
    constraintMap({
      w1: { minWidth: 400, maxWidth: 500 },
      w2: { minWidth: 300, maxWidth: 600 },
      h1: { minWidth: 200, maxWidth: 400 },
      h2: { minWidth: 350, maxWidth: 600 },
    }),
  );

  test("minimums sum along the split axis (+gap); maximum sums only when BOTH sides bounded", () => {
    const both = aggregateBounds(split("vertical", 0.5, leaf("w1"), leaf("w2")), "vertical", 8, resolve);
    expect(both).toEqual({ min: 708, max: 1108 });

    const oneUnbounded = aggregateBounds(
      split("vertical", 0.5, leaf("w1"), leaf("free")),
      "vertical",
      8,
      resolve,
    );
    expect(oneUnbounded.min).toBe(408);
    expect(oneUnbounded.max).toBeUndefined();
  });

  test("across the split axis children share extent: tightest child bound applies", () => {
    const node = split("horizontal", 0.5, leaf("h1"), leaf("h2"));
    const cross = aggregateBounds(node, "vertical", 8, resolve);
    expect(cross).toEqual({ min: 350, max: 400 });
  });

  test("unbounded leaves contribute no bounds", () => {
    expect(aggregateBounds(leaf("free"), "vertical", 8, resolve)).toEqual({});
    expect(
      aggregateBounds(split("vertical", 0.5, leaf("free"), leaf("free2")), "vertical", 8, resolve),
    ).toEqual({});
  });
});

describe("tree validation", () => {
  test("duplicate ids resolve first-wins in traversal and layout", () => {
    const tree = split(
      "vertical",
      0.5,
      leaf("dup"),
      split("horizontal", 0.5, leaf("dup"), leaf("other")),
    );
    expect(memberIds(tree)).toEqual(["dup", "other"]);

    const plan = planLayout({
      tree,
      content: frame(0, 0, 1512, 944),
      gap: BSP_DEFAULT_GAP,
      resolve: () => undefined,
    });
    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    expect(plan.frames.size).toBe(2);
    expect(plan.frames.get("dup")).toEqual(frame(0, 0, 756, 944));
    expect(plan.frames.get("other")).toEqual(frame(764, 480, 748, 464));
  });

  test("NaN and out-of-range ratios are rejected by validation", () => {
    expect(isValidRatio(Number.NaN)).toBe(false);
    expect(isValidRatio(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidRatio(0)).toBe(false);
    expect(isValidRatio(-0.25)).toBe(false);
    expect(isValidRatio(1)).toBe(false);
    expect(isValidRatio(0.5)).toBe(true);
  });

  test("an invalid ratio falls back to 0.5 during the solve instead of corrupting panes", () => {
    expect(partitionLengths(1000, BSP_DEFAULT_GAP, Number.NaN, {}, {})).toEqual({
      first: 500,
      second: 492,
      feasible: true,
    });
    expect(axisForFrame(frame(0, 0, 600, 600))).toBe("vertical");
    expect(axisForFrame(frame(0, 0, 801, 800))).toBe("vertical");
    expect(axisForFrame(frame(0, 0, 800, 801))).toBe("horizontal");
  });
});
