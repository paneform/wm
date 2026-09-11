import { describe, expect, test } from "vitest";
import { planWindowInsertion } from "../src/insertion-frame.ts";
import { planLayout, type ConstraintResolver } from "../src/layout/bsp.ts";
import type { Frame } from "../src/schema.ts";
import type { BspNode, World, WorkspaceState } from "../src/world.ts";

const frame = (x: number, y: number, width: number, height: number): Frame => ({
  x,
  y,
  width,
  height,
});
const leaf = (windowId: string): BspNode => ({ kind: "leaf", windowId });
const split = (axis: "vertical" | "horizontal", first: BspNode, second: BspNode): BspNode => ({
  kind: "split",
  axis,
  ratio: 0.5,
  first,
  second,
});

function fixture(tree: BspNode, focused: string | null = null) {
  const workspace: WorkspaceState = {
    name: "1",
    mode: "bsp",
    tree,
    floating: new Set(),
    visibleOnDisplay: "display:1",
    preferredDisplay: "display:1",
    pinnedDisplayOverride: null,
    parkedFrames: new Map(),
    lastFocusedMember: focused,
    lastFocusedTiledMember: focused,
  };
  // SAFETY: This fixture supplies every World field used by the pure planner.
  const world = {
    topology: {
      displays: [
        {
          id: "display:1",
          frame: frame(0, 0, 1000, 600),
          workArea: frame(0, 0, 1000, 600),
          scale: 2,
          primary: true,
        },
      ],
    },
    windows: new Map(),
    workspaces: new Map([[workspace.name, workspace]]),
    focusedWorkspace: workspace.name,
    profiles: new Map(),
    parkingFacts: [],
    paused: false,
    epoch: 0,
    focusIntent: null,
  } as World;
  return { world, workspace };
}

const plan = (
  tree: BspNode,
  focused: string | null,
  resolve: ConstraintResolver = () => undefined,
  margins = {},
  gap = 8,
) => {
  const { world, workspace } = fixture(tree, focused);
  return planWindowInsertion({ world, workspace, newId: "new", margins, gap, resolve });
};

describe("window insertion planner", () => {
  test("splits the focused logical tile with the shortest divider", () => {
    const result = plan(split("vertical", leaf("a"), leaf("b")), "b");

    expect(result?.beside).toBe("b");
    expect(result?.axis).toBe("horizontal");
    expect(result?.frame).toEqual(frame(508, 308, 492, 292));
  });

  test("uses the other axis when minima and gap make the preferred split infeasible", () => {
    const resolve: ConstraintResolver = (id) =>
      id === "a" || id === "new" ? { width: { min: 600 }, height: { min: 200 } } : undefined;
    const result = plan(leaf("a"), "a", resolve);

    expect(result?.axis).toBe("horizontal");
    expect(result?.frame).toEqual(frame(0, 308, 1000, 292));
  });

  test("honors margins, gap, and maximum size", () => {
    const result = plan(
      leaf("a"),
      "a",
      (id) => (id === "new" ? { width: { max: 300 } } : undefined),
      { left: 20, right: 20, top: 10, bottom: 10 },
      10,
    );

    expect(result?.axis).toBe("vertical");
    expect(result?.frame).toEqual(frame(680, 10, 300, 580));
  });

  test("preserves unrelated nested branches and falls back to the first leaf", () => {
    const tree = split("vertical", leaf("a"), split("horizontal", leaf("b"), leaf("c")));
    const result = plan(tree, "missing");

    expect(result?.beside).toBe("a");
    expect(result?.tree).toEqual(
      split(
        "vertical",
        split("horizontal", leaf("a"), leaf("new")),
        split("horizontal", leaf("b"), leaf("c")),
      ),
    );
    if (result === null) return;
    const layout = planLayout({
      tree: result.tree,
      content: frame(0, 0, 1000, 600),
      gap: 8,
      resolve: () => undefined,
    });
    expect(layout.feasible && layout.frames.get("b")).toEqual(frame(508, 0, 492, 300));
    expect(layout.feasible && layout.frames.get("c")).toEqual(frame(508, 308, 492, 292));
  });

  test("retains a divider previously clamped by an ancestor maximum", () => {
    const tree = split("vertical", leaf("a"), leaf("b"));
    const resolve: ConstraintResolver = (id) => (id === "a" ? { width: { max: 400 } } : undefined);
    const result = plan(tree, "a", resolve);

    expect(result?.axis).toBe("horizontal");
    expect(result?.frame).toEqual(frame(0, 308, 400, 292));
    if (result === null) return;
    const layout = planLayout({
      tree: result.tree,
      content: frame(0, 0, 1000, 600),
      gap: 8,
      resolve,
    });
    expect(layout.feasible && layout.frames.get("b")).toEqual(frame(408, 0, 592, 600));
    if (result.tree.kind !== "split" || tree.kind !== "split") return;
    expect(result.tree.second).toBe(tree.second);
  });

  test("uses planned logical geometry instead of a parked observed frame", () => {
    const { world, workspace } = fixture(split("vertical", leaf("a"), leaf("b")), "b");
    workspace.visibleOnDisplay = null;
    workspace.parkedFrames = new Map([["b", frame(-9000, -9000, 20, 1000)]]);

    const result = planWindowInsertion({
      world,
      workspace,
      newId: "new",
      margins: {},
      gap: 8,
      resolve: () => undefined,
    });

    expect(result?.axis).toBe("horizontal");
    expect(result?.frame).toEqual(frame(508, 308, 492, 292));
  });

  test("preserves the default fallback when neither strict split fits", () => {
    const result = plan(leaf("a"), "a", () => ({
      width: { min: 700 },
      height: { min: 500 },
    }));

    expect(result?.axis).toBe("vertical");
    expect(result?.frame).toEqual(frame(300, 0, 700, 600));
  });
});
