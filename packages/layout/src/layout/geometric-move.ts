import type { Direction } from "../direction.js";
import type { Frame, WindowId } from "../schema.js";
import type { BspNode, SplitAxis } from "../world.js";
import { isFiniteFrame, withinTolerance } from "../geometry.js";
import { planLayout, ratioForLength, removeLeaf } from "./bsp.js";

type Split = Extract<BspNode, { kind: "split" }>;
type Dimension = "x" | "y";
interface Region {
  node: BspNode;
  frame: Frame;
  area: number;
  path: Split[];
}

interface SizedPane {
  node: BspNode;
  size: number;
}

export interface GeometricMoveInput {
  tree: BspNode;
  movedId: WindowId;
  direction: Direction;
  frames: ReadonlyMap<WindowId, Frame>;
  gap?: number;
  groups?: boolean;
}

// Frame rounding may displace a shared border by a pixel on either side.
const BORDER_TOLERANCE = 2;
const length = (frame: Frame, dimension: Dimension): number =>
  dimension === "x" ? frame.width : frame.height;
const end = (frame: Frame, dimension: Dimension): number =>
  frame[dimension] + length(frame, dimension);
const otherDimension = (dimension: Dimension): Dimension => (dimension === "x" ? "y" : "x");
const axisOf = (dimension: Dimension): SplitAxis => (dimension === "x" ? "vertical" : "horizontal");
const close = (a: number, b: number): boolean => Math.abs(a - b) <= BORDER_TOLERANCE;
const overlap = (a: Frame, b: Frame, d: Dimension): number =>
  Math.min(end(a, d), end(b, d)) - Math.max(a[d], b[d]);
const intervalGap = (a: Frame, b: Frame, d: Dimension): number => Math.max(0, -overlap(a, b, d));

function union(a: Frame, b: Frame): Frame {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(end(a, "x"), end(b, "x")) - x,
    height: Math.max(end(a, "y"), end(b, "y")) - y,
  };
}

function regionsOf(tree: BspNode, frames: ReadonlyMap<WindowId, Frame>): Region[] {
  const regions: Region[] = [];
  const visit = (node: BspNode, path: Split[]): Region | undefined => {
    if (node.kind === "leaf") {
      const frame = frames.get(node.windowId);
      if (frame === undefined || !isFiniteFrame(frame) || frame.width <= 0 || frame.height <= 0)
        return undefined;
      const region = { node, frame, area: frame.width * frame.height, path };
      regions.push(region);
      return region;
    }
    const first = visit(node.first, [...path, node]);
    const second = visit(node.second, [...path, node]);
    if (first === undefined || second === undefined) return undefined;
    const region = {
      node,
      frame: union(first.frame, second.frame),
      area: first.area + second.area,
      path,
    };
    regions.push(region);
    return region;
  };
  visit(tree, []);
  return regions;
}

function replaceNode(tree: BspNode, target: BspNode, replacement: BspNode): BspNode {
  if (tree === target) return replacement;
  if (tree.kind === "leaf") return tree;
  const first = replaceNode(tree.first, target, replacement);
  const second = replaceNode(tree.second, target, replacement);
  return first === tree.first && second === tree.second ? tree : { ...tree, first, second };
}

function commonAncestor(a: Region, b: Region): Split | undefined {
  let shared: Split | undefined;
  for (let i = 0; i < Math.min(a.path.length, b.path.length); i += 1) {
    if (a.path[i] !== b.path[i]) break;
    shared = a.path[i];
  }
  return shared;
}

function splitToward(
  axis: SplitAxis,
  ratio: number,
  moved: BspNode,
  rest: BspNode,
  before: boolean,
): Split {
  return {
    kind: "split",
    axis,
    ratio,
    first: before ? moved : rest,
    second: before ? rest : moved,
  };
}

function forwardTarget(
  origin: Region,
  leaves: Region[],
  dimension: Dimension,
  before: boolean,
): Region | undefined {
  const orthogonal = otherDimension(dimension);
  const sign = before ? -1 : 1;
  const candidates = leaves.filter(
    ({ node, frame }) =>
      node !== origin.node &&
      sign * (frame[dimension] - origin.frame[dimension]) > BORDER_TOLERANCE &&
      sign * (end(frame, dimension) - end(origin.frame, dimension)) > BORDER_TOLERANCE,
  );
  candidates.sort((a, b) => {
    const directA = overlap(origin.frame, a.frame, orthogonal) > 0;
    const directB = overlap(origin.frame, b.frame, orthogonal) > 0;
    return (
      Number(directB) - Number(directA) ||
      Math.hypot(
        intervalGap(origin.frame, a.frame, dimension),
        intervalGap(origin.frame, a.frame, orthogonal),
      ) -
        Math.hypot(
          intervalGap(origin.frame, b.frame, dimension),
          intervalGap(origin.frame, b.frame, orthogonal),
        ) ||
      Math.abs(
        a.frame[orthogonal] +
          length(a.frame, orthogonal) / 2 -
          origin.frame[orthogonal] -
          length(origin.frame, orthogonal) / 2,
      ) -
        Math.abs(
          b.frame[orthogonal] +
            length(b.frame, orthogonal) / 2 -
            origin.frame[orthogonal] -
            length(origin.frame, orthogonal) / 2,
        )
    );
  });
  return candidates[0];
}

function flattenAxis(tree: BspNode, axis: SplitAxis): BspNode[] {
  return tree.kind === "split" && tree.axis === axis
    ? [...flattenAxis(tree.first, axis), ...flattenAxis(tree.second, axis)]
    : [tree];
}

/** Reuse the divider topology, but let each pane carry its observed length. */
function swapAlongAxis(
  tree: BspNode,
  ancestor: Split,
  origin: Region,
  target: Region,
  regions: Region[],
  dimension: Dimension,
  gap: number,
): BspNode | undefined {
  const axis = axisOf(dimension);
  const panes = flattenAxis(ancestor, axis);
  const from = panes.indexOf(origin.node);
  const to = panes.indexOf(target.node);
  if (from < 0 || to < 0) return undefined;
  const byNode = new Map(regions.map((region) => [region.node, region]));
  const ordered = [...panes];
  ordered[from] = target.node;
  ordered[to] = origin.node;
  let index = 0;
  const rebuild = (node: BspNode): SizedPane => {
    if (node.kind !== "split" || node.axis !== axis) {
      const next = ordered[index++]!;
      return { node: next, size: length(byNode.get(next)!.frame, dimension) };
    }
    const first = rebuild(node.first);
    const second = rebuild(node.second);
    const size = first.size + gap + second.size;
    return {
      node: {
        ...node,
        ratio: ratioForLength(first.size, size - gap),
        first: first.node,
        second: second.node,
      },
      size,
    };
  };
  return replaceNode(tree, ancestor, rebuild(ancestor).node);
}

function sliceFrames(regions: Region[], dimensions: Dimension[], gap: number): BspNode | undefined {
  if (regions.length === 1) return regions[0]!.node;
  const bounds = regions.map(({ frame }) => frame).reduce(union);
  for (const dimension of dimensions) {
    const ordered = [...regions].sort((a, b) => a.frame[dimension] - b.frame[dimension]);
    let border = end(ordered[0]!.frame, dimension);
    for (let i = 1; i < ordered.length; i += 1) {
      if (border <= ordered[i]!.frame[dimension] + BORDER_TOLERANCE) {
        const first = sliceFrames(ordered.slice(0, i), dimensions, gap);
        const second = sliceFrames(ordered.slice(i), dimensions, gap);
        const ratio = ratioForLength(border - bounds[dimension], length(bounds, dimension) - gap);
        if (first !== undefined && second !== undefined && ratio > 0 && ratio < 1) {
          return { kind: "split", axis: axisOf(dimension), ratio, first, second };
        }
      }
      border = Math.max(border, end(ordered[i]!.frame, dimension));
    }
  }
  return undefined;
}

/** Aligned grid cells may have equivalent row-first or column-first trees. */
function swapAlignedFrames(
  input: GeometricMoveInput,
  ancestor: Split,
  origin: Region,
  target: Region,
  regions: Region[],
  dimension: Dimension,
): BspNode {
  const [first, second] =
    origin.frame[dimension] < target.frame[dimension] ? [origin, target] : [target, origin];
  const separation = second.frame[dimension] - end(first.frame, dimension);
  const desired = regions
    .filter(({ node, path }) => node.kind === "leaf" && path.includes(ancestor))
    .map((region) => {
      if (region === second)
        return { ...region, frame: { ...region.frame, [dimension]: first.frame[dimension] } };
      if (region === first)
        return {
          ...region,
          frame: {
            ...region.frame,
            [dimension]: first.frame[dimension] + length(second.frame, dimension) + separation,
          },
        };
      return region;
    });
  const tree = sliceFrames(desired, [otherDimension(dimension), dimension], input.gap ?? 0);
  if (tree === undefined) return input.tree;
  const content = desired.map(({ frame }) => frame).reduce(union);
  const plan = planLayout({ tree, content, gap: input.gap ?? 0, resolve: () => undefined }, [
    "greedy",
  ]);
  // Overlapping or drifting observations need not form a slicing floorplan.
  if (
    !plan.feasible ||
    !desired.every(
      ({ node, frame }) =>
        node.kind === "leaf" &&
        withinTolerance(plan.frames.get(node.windowId)!, frame, BORDER_TOLERANCE),
    )
  )
    return input.tree;
  return replaceNode(input.tree, ancestor, tree);
}

function moveDirect(
  input: GeometricMoveInput,
  origin: Region,
  target: Region,
  regions: Region[],
  dimension: Dimension,
): BspNode {
  const ancestor = commonAncestor(origin, target);
  if (ancestor === undefined) return input.tree;
  const orthogonal = otherDimension(dimension);
  if (
    close(origin.frame[orthogonal], target.frame[orthogonal]) &&
    close(end(origin.frame, orthogonal), end(target.frame, orthogonal))
  ) {
    const swapped = swapAlongAxis(
      input.tree,
      ancestor,
      origin,
      target,
      regions,
      dimension,
      input.gap ?? 0,
    );
    if (swapped !== undefined) return swapped;
    return swapAlignedFrames(input, ancestor, origin, target, regions, dimension);
  }
  const parent = origin.path.at(-1)!;
  if (parent.axis !== axisOf(dimension)) {
    // Carry the moved pane's perpendicular divider across the T junction.
    const pair = {
      ...parent,
      first: parent.first === origin.node ? origin.node : target.node,
      second: parent.second === origin.node ? origin.node : target.node,
    };
    return replaceNode(removeLeaf(input.tree, input.movedId)!, target.node, pair);
  }
  const targetParent = target.path.at(-1)!;
  if (targetParent.axis !== axisOf(dimension)) {
    if (origin.path.includes(targetParent)) return input.tree;
    const rest = targetParent.first === target.node ? targetParent.second : targetParent.first;
    const pair = {
      ...targetParent,
      first: targetParent.first === target.node ? rest : origin.node,
      second: targetParent.first === target.node ? origin.node : rest,
    };
    return replaceNode(replaceNode(input.tree, origin.node, target.node), targetParent, pair);
  }
  // Constraint drift can make differently sized parallel panes look unaligned.
  return (
    swapAlongAxis(input.tree, ancestor, origin, target, regions, dimension, input.gap ?? 0) ??
    input.tree
  );
}

function moveDiagonal(
  input: GeometricMoveInput,
  origin: Region,
  target: Region,
  dimension: Dimension,
): BspNode {
  const orthogonal = otherDimension(dimension);
  const pair = splitToward(
    axisOf(orthogonal),
    0.5,
    origin.node,
    target.node,
    origin.frame[orthogonal] < target.frame[orthogonal],
  );
  return replaceNode(removeLeaf(input.tree, input.movedId)!, target.node, pair);
}

function edgeCandidates(
  origin: Region,
  regions: Region[],
  dimension: Dimension,
  before: boolean,
  groups: boolean,
): Region[] {
  const orthogonal = otherDimension(dimension);
  const border = (frame: Frame): number => (before ? frame[dimension] : end(frame, dimension));
  const outer = (before ? Math.min : Math.max)(...regions.map(({ frame }) => border(frame)));
  if (!close(border(origin.frame), outer)) return [];
  const eligible = regions.filter(
    (region) =>
      region.node !== origin.node &&
      !(region.node.kind === "split" && origin.path.includes(region.node)) &&
      (groups || region.node.kind === "leaf") &&
      close(border(region.frame), outer) &&
      overlap(origin.frame, region.frame, orthogonal) <= BORDER_TOLERANCE,
  );
  // Only immediately adjacent regions on either side can claim the shared edge.
  return eligible.filter(
    (candidate) =>
      !eligible.some(
        (other) =>
          other.frame[orthogonal] < origin.frame[orthogonal] ===
            candidate.frame[orthogonal] < origin.frame[orthogonal] &&
          intervalGap(origin.frame, other.frame, orthogonal) + BORDER_TOLERANCE <
            intervalGap(origin.frame, candidate.frame, orthogonal),
      ),
  );
}

function removeForEdge(input: GeometricMoveInput, dimension: Dimension): BspNode {
  const axis = axisOf(otherDimension(dimension));
  const gap = input.gap ?? 0;
  const extent = (node: BspNode): number => {
    if (node.kind === "leaf")
      return length(input.frames.get(node.windowId)!, otherDimension(dimension));
    const first = extent(node.first);
    const second = extent(node.second);
    return node.axis === axis ? first + gap + second : Math.max(first, second);
  };
  const remove = (node: BspNode): BspNode | null => {
    if (node.kind === "leaf") return node.windowId === input.movedId ? null : node;
    const first = remove(node.first);
    const second = remove(node.second);
    if (first === null) return second;
    if (second === null) return first;
    if (first === node.first && second === node.second) return node;
    const ratio =
      node.axis === axis
        ? ratioForLength(extent(first), extent(first) + extent(second))
        : node.ratio;
    return { ...node, ratio, first, second };
  };
  return remove(input.tree)!;
}

function edgePair(
  ancestor: Split,
  origin: Region,
  target: Region,
  axis: SplitAxis,
  before: boolean,
  movedId: WindowId,
): Split {
  const parent = origin.path.at(-1)!;
  let rest = removeLeaf(ancestor, movedId)!;
  const targetParent = target.path.at(-1)!;
  const sourceIsChild = ancestor.first === origin.node || ancestor.second === origin.node;
  const targetIsChild = ancestor.first === target.node || ancestor.second === target.node;
  if (sourceIsChild && !targetIsChild && targetParent.axis === axis) {
    // Matching one pane does not carry its whole stack along as a group.
    rest = replaceNode(rest, targetParent, {
      ...targetParent,
      axis: axis === "vertical" ? "horizontal" : "vertical",
    });
  }
  return splitToward(
    axis,
    parent.axis === axis ? parent.ratio : ancestor.ratio,
    origin.node,
    rest,
    before,
  );
}

function pairAdjacentRegions(
  input: GeometricMoveInput,
  ancestor: Split,
  origin: Region,
  target: Region,
  regions: Region[],
  dimension: Dimension,
  before: boolean,
): BspNode | undefined {
  const orthogonal = otherDimension(dimension);
  const axis = axisOf(orthogonal);
  const panes = flattenAxis(ancestor, axis);
  const contains = (node: BspNode, region: Region): boolean =>
    node === region.node || (node.kind === "split" && region.path.includes(node));
  const from = panes.findIndex((node) => contains(node, origin));
  const to = panes.findIndex((node) => contains(node, target));
  if (from < 0 || to < 0 || Math.abs(from - to) !== 1) return undefined;
  const sizes = new Map(regions.map(({ node, frame }) => [node, length(frame, orthogonal)]));
  const gap = input.gap ?? 0;
  const firstIndex = Math.min(from, to);
  const first = panes[firstIndex]!;
  const second = panes[firstIndex + 1]!;
  const pairSize = sizes.get(first)! + gap + sizes.get(second)!;
  const pair =
    panes.length === 2
      ? ancestor
      : {
          kind: "split" as const,
          axis,
          ratio: ratioForLength(sizes.get(first)!, pairSize - gap),
          first,
          second,
        };
  const rotated = edgePair(pair, origin, target, axisOf(dimension), before, input.movedId);
  const ordered: SizedPane[] = panes.map((node) => ({ node, size: sizes.get(node)! }));
  ordered.splice(firstIndex, 2, { node: rotated, size: pairSize });
  return replaceNode(input.tree, ancestor, joinPanes(ordered, axis, gap).node);
}

function joinPanes(panes: SizedPane[], axis: SplitAxis, gap: number): SizedPane {
  return panes.reduceRight((right, left) => {
    const size = left.size + gap + right.size;
    return {
      node: {
        kind: "split",
        axis,
        ratio: ratioForLength(left.size, size - gap),
        first: left.node,
        second: right.node,
      },
      size,
    } satisfies SizedPane;
  });
}

function rotateOuterEdge(
  input: GeometricMoveInput,
  origin: Region,
  target: Region,
  regions: Region[],
  ancestor: Split,
  dimension: Dimension,
  before: boolean,
): BspNode | undefined {
  const axis = axisOf(dimension);
  const ancestorIndex = origin.path.indexOf(ancestor);
  const parent = origin.path[ancestorIndex - 1];
  if (
    origin.path.at(-1) !== ancestor ||
    (ancestor.first !== target.node && ancestor.second !== target.node) ||
    parent?.axis !== axis ||
    (before ? parent.first : parent.second) !== ancestor
  )
    return undefined;
  let run = parent;
  for (let i = ancestorIndex - 2; i >= 0 && origin.path[i]!.axis === axis; i -= 1)
    run = origin.path[i]!;
  const panes = flattenAxis(run, axis);
  const index = panes.indexOf(ancestor);
  const outerIndex = index + (before ? 1 : -1);
  const outerPane = panes[outerIndex];
  if (outerPane === undefined) return undefined;
  const sizes = new Map(regions.map(({ node, frame }) => [node, length(frame, dimension)]));
  const gap = input.gap ?? 0;
  const size = sizes.get(outerPane)! + gap + sizes.get(ancestor)!;
  const ratio =
    panes.length === 2
      ? parent.ratio
      : ratioForLength(sizes.get(panes[Math.min(index, outerIndex)]!)!, size - gap);
  const pair = splitToward(axis, ancestor.ratio, origin.node, outerPane, before);
  const rotated = splitToward(axis, ratio, pair, target.node, before);
  const ordered = panes.map((node) => ({ node, size: sizes.get(node)! }));
  ordered.splice(Math.min(index, outerIndex), 2, { node: rotated, size });
  return replaceNode(input.tree, run, joinPanes(ordered, axis, gap).node);
}

function moveAtEdge(
  input: GeometricMoveInput,
  origin: Region,
  regions: Region[],
  dimension: Dimension,
  before: boolean,
): BspNode {
  const candidates = edgeCandidates(origin, regions, dimension, before, input.groups ?? false);
  if (candidates.length === 0) return input.tree;
  candidates.sort((a, b) => Math.abs(a.area - origin.area) - Math.abs(b.area - origin.area));
  const target = candidates[0]!;
  // A one-pixel rounding difference in either dimension is not a meaningful size preference.
  const areaTolerance = origin.frame.width + origin.frame.height;
  const tied =
    candidates[1] !== undefined &&
    Math.abs(Math.abs(candidates[1].area - origin.area) - Math.abs(target.area - origin.area)) <=
      areaTolerance;
  const axis = axisOf(dimension);
  if (tied) return splitToward(axis, 0.5, origin.node, removeForEdge(input, dimension), before);
  const ancestor = commonAncestor(origin, target);
  if (ancestor === undefined) return input.tree;
  const rotated = rotateOuterEdge(input, origin, target, regions, ancestor, dimension, before);
  if (rotated !== undefined) return rotated;
  return (
    pairAdjacentRegions(input, ancestor, origin, target, regions, dimension, before) ??
    replaceNode(
      input.tree,
      ancestor,
      edgePair(ancestor, origin, target, axis, before, input.movedId),
    )
  );
}

/** Observations choose the visual transformation; untouched tree dividers retain their ratios. */
export function moveGeometrically(input: GeometricMoveInput): BspNode {
  const regions = regionsOf(input.tree, input.frames);
  // Do not restructure a layout whose visible geometry is incomplete.
  if (!regions.some(({ node }) => node === input.tree)) return input.tree;
  const leaves = regions.filter(({ node }) => node.kind === "leaf");
  const origin = leaves.find(({ node }) => node.kind === "leaf" && node.windowId === input.movedId);
  if (origin === undefined || leaves.length < 2) return input.tree;
  const dimension = input.direction === "left" || input.direction === "right" ? "x" : "y";
  const before = input.direction === "left" || input.direction === "up";
  const target = forwardTarget(origin, leaves, dimension, before);
  if (target === undefined) return moveAtEdge(input, origin, regions, dimension, before);
  return overlap(origin.frame, target.frame, otherDimension(dimension)) > 0
    ? moveDirect(input, origin, target, regions, dimension)
    : moveDiagonal(input, origin, target, dimension);
}
