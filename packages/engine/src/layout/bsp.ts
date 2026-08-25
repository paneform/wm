import type { Constraints, DisplayObservation, Frame, WindowId } from "../schema.ts";
import type { BspNode, SplitAxis } from "../world.ts";
import {
  BSP_DEFAULT_GAP,
  DEFAULT_POLICY_CHAIN,
  EMPTY_TREE_LEAF,
  type LayoutPolicy,
} from "../constants.ts";
import {
  insetFrame,
  isFiniteFrame,
  type FrameComponent,
} from "../geometry.ts";

// ---------------------------------------------------------------------------
// Tree shape helpers
// ---------------------------------------------------------------------------

export const isValidRatio = (ratio: number): boolean =>
  Number.isFinite(ratio) && ratio > 0 && ratio < 1;

/** Longest dimension of a frame; square tiles split with a vertical divider. */
export function axisForFrame(frame: Frame): SplitAxis {
  return frame.width >= frame.height ? "vertical" : "horizontal";
}

const axisComponent = (axis: SplitAxis): FrameComponent => (axis === "vertical" ? "width" : "height");

const shrinkRect = (rect: Frame, axis: SplitAxis, length: number): Frame =>
  axis === "vertical" ? { ...rect, width: length } : { ...rect, height: length };

const offsetRect = (rect: Frame, axis: SplitAxis, delta: number): Frame =>
  axis === "vertical" ? { ...rect, x: rect.x + delta } : { ...rect, y: rect.y + delta };

export function findLeaf(tree: BspNode, windowId: WindowId): boolean {
  if (tree.kind === "leaf") return tree.windowId === windowId;
  return findLeaf(tree.first, windowId) || findLeaf(tree.second, windowId);
}

export function firstLeaf(tree: BspNode): WindowId | null {
  return tree.kind === "leaf" ? tree.windowId : firstLeaf(tree.first);
}

/** Leaf ids in traversal order, deduplicated first-wins. */
export function memberIds(tree: BspNode): WindowId[] {
  const seen = new Set<WindowId>();
  const out: WindowId[] = [];
  for (const id of leavesRaw(tree)) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function leavesRaw(tree: BspNode): WindowId[] {
  return tree.kind === "leaf" ? [tree.windowId] : [...leavesRaw(tree.first), ...leavesRaw(tree.second)];
}

/**
 * Insert `newId` beside `targetId`, splitting the target leaf along its
 * longest dimension (square ⇒ vertical divider). The existing window stays
 * left/top; the new window becomes the right/bottom second child at ratio 0.5.
 * Returns null when the target leaf does not exist.
 */
export function insertLeaf(
  tree: BspNode,
  targetId: WindowId,
  newId: WindowId,
  targetFrame?: Frame | undefined,
): BspNode | null {
  if (tree.kind === "leaf") {
    if (tree.windowId !== targetId) return null;
    const axis = targetFrame !== undefined ? axisForFrame(targetFrame) : "vertical";
    return {
      kind: "split",
      axis,
      ratio: 0.5,
      first: { kind: "leaf", windowId: targetId },
      second: { kind: "leaf", windowId: newId },
    };
  }
  const first = insertLeaf(tree.first, targetId, newId, targetFrame);
  if (first) return { ...tree, first };
  const second = insertLeaf(tree.second, targetId, newId, targetFrame);
  return second ? { ...tree, second } : null;
}

/** Remove a leaf; the sibling subtree is promoted wholesale. Null when emptied. */
export function removeLeaf(tree: BspNode, windowId: WindowId): BspNode | null {
  if (tree.kind === "leaf") return tree.windowId === windowId ? null : tree;
  const first = removeLeaf(tree.first, windowId);
  if (first === null) return tree.second;
  const second = removeLeaf(tree.second, windowId);
  if (second === null) return tree.first;
  return { ...tree, first, second };
}

export function replaceLeaf(tree: BspNode, oldId: WindowId, newId: WindowId): BspNode | null {
  if (tree.kind === "leaf") {
    if (tree.windowId !== oldId) return null;
    return { kind: "leaf", windowId: newId };
  }
  const first = replaceLeaf(tree.first, oldId, newId);
  if (first) return { ...tree, first };
  const second = replaceLeaf(tree.second, oldId, newId);
  return second ? { ...tree, second } : null;
}

export function swapLeaves(tree: BspNode, a: WindowId, b: WindowId): BspNode {
  const map = (node: BspNode): BspNode => {
    if (node.kind === "leaf") {
      if (node.windowId === a) return { kind: "leaf", windowId: b };
      if (node.windowId === b) return { kind: "leaf", windowId: a };
      return node;
    }
    return { ...node, first: map(node.first), second: map(node.second) };
  };
  return map(tree);
}

/** Members that participate in layout; filters the empty-tree sentinel. */
export function tiledMembers(tree: BspNode): WindowId[] {
  return memberIds(tree).filter((id) => id !== EMPTY_TREE_LEAF);
}

export const isEmptyTree = (tree: BspNode): boolean =>
  tree.kind === "leaf" && tree.windowId === EMPTY_TREE_LEAF;

// ---------------------------------------------------------------------------
// Constraint-aware solve
// ---------------------------------------------------------------------------

export interface AxisBounds {
  min?: number | undefined;
  max?: number | undefined;
}

export interface PaneConstraints {
  width?: AxisBounds | undefined;
  height?: AxisBounds | undefined;
}

export type ConstraintResolver = (windowId: WindowId) => PaneConstraints | undefined;

export const boundsFromConstraints = (
  constraints: Constraints | undefined,
  component: "width" | "height",
): AxisBounds | undefined => {
  if (constraints === undefined) return undefined;
  const min =
    component === "width"
      ? constraints.minWidth
      : constraints.minHeight;
  const max =
    component === "width"
      ? constraints.maxWidth
      : constraints.maxHeight;
  if (min === undefined && max === undefined) return undefined;
  const bounds: AxisBounds = {};
  if (min !== undefined) bounds.min = min;
  if (max !== undefined) bounds.max = max;
  return bounds;
};

/** Build a layout resolver from a per-window Constraints lookup. */
export const constraintsResolver =
  (get: (windowId: WindowId) => Constraints | undefined): ConstraintResolver =>
  (windowId) => {
    const c = get(windowId);
    return {
      width: boundsFromConstraints(c, "width"),
      height: boundsFromConstraints(c, "height"),
    };
  };

/**
 * Aggregate subtree bounds along an axis. Minimums sum along the split axis
 * (+ gap); maximum sums only when BOTH sides are bounded. Across the split
 * axis children share extent, so the tightest child bound applies.
 */
export function aggregateBounds(
  node: BspNode,
  axis: SplitAxis,
  gap: number,
  resolve: ConstraintResolver,
): AxisBounds {
  if (node.kind === "leaf") {
    const c = resolve(node.windowId);
    if (c === undefined) return {};
    return axis === "vertical" ? { ...(c.width ?? {}) } : { ...(c.height ?? {}) };
  }
  const a = aggregateBounds(node.first, axis, gap, resolve);
  const b = aggregateBounds(node.second, axis, gap, resolve);
  if (node.axis === axis) {
    const summedMin =
      a.min === undefined && b.min === undefined
        ? undefined
        : (a.min ?? 0) + gap + (b.min ?? 0);
    const summedMax = a.max !== undefined && b.max !== undefined ? a.max + gap + b.max : undefined;
    const out: AxisBounds = {};
    if (summedMin !== undefined) out.min = summedMin;
    if (summedMax !== undefined) out.max = summedMax;
    return out;
  }
  const crossMin = a.min !== undefined || b.min !== undefined ? Math.max(a.min ?? -Infinity, b.min ?? -Infinity) : undefined;
  const crossMax = a.max !== undefined && b.max !== undefined ? Math.min(a.max, b.max) : undefined;
  const out: AxisBounds = {};
  if (crossMin !== undefined) out.min = crossMin;
  if (crossMax !== undefined) out.max = crossMax;
  return out;
}

const clampToBounds = (value: number, bounds: AxisBounds): number => {
  let v = value;
  if (bounds.min !== undefined && v < bounds.min) v = bounds.min;
  if (bounds.max !== undefined && v > bounds.max) v = bounds.max;
  return v;
};

const withinBounds = (value: number, bounds: AxisBounds): boolean =>
  (bounds.min === undefined || value >= bounds.min) &&
  (bounds.max === undefined || value <= bounds.max);

export interface PartitionResult {
  first: number;
  second: number;
  feasible: boolean;
}

/**
 * Two-pane length solve. Preferred first pane = floor(available · ratio); the
 * second pane starts after the gap. Each side is clamped into its bounds,
 * deficits/surplus flowing to the peer, iterated to a fixed point.
 * Degenerate ranges collapse safely (feasible=false rather than negative panes).
 */
export function partitionLengths(
  available: number,
  gap: number,
  ratio: number,
  firstBounds: AxisBounds,
  secondBounds: AxisBounds,
): PartitionResult {
  if (!isValidRatio(ratio)) ratio = 0.5;
  const space = available - gap;
  if (space <= 0) return { first: 0, second: 0, feasible: false };

  let first = Math.floor(available * ratio);
  for (let i = 0; i < 4; i++) {
    first = clampToBounds(first, firstBounds);
    const second = space - first;
    const clampedSecond = clampToBounds(second, secondBounds);
    if (clampedSecond === second) break;
    first = space - clampedSecond;
  }
  first = clampToBounds(first, firstBounds);
  const second = space - first;

  const feasible =
    first > 0 &&
    second > 0 &&
    withinBounds(first, firstBounds) &&
    withinBounds(second, secondBounds);
  return { first, second, feasible };
}

// ---------------------------------------------------------------------------
// Policy chain planning
// ---------------------------------------------------------------------------

export interface LayoutInput {
  tree: BspNode;
  content: Frame;
  gap?: number | undefined;
  resolve: ConstraintResolver;
}

export type LayoutPlan =
  | { feasible: true; policy: LayoutPolicy; frames: ReadonlyMap<WindowId, Frame> }
  | { feasible: false };

/** Usable content rect for a workspace on a display: work area minus margins. */
export function contentRect(
  display: DisplayObservation,
  margins?:
    | {
        top?: number | undefined;
        right?: number | undefined;
        bottom?: number | undefined;
        left?: number | undefined;
      }
    | undefined,
): Frame {
  return insetFrame(display.workArea, margins);
}

function assignFrames(
  node: BspNode,
  rect: Frame,
  gap: number,
  resolve: ConstraintResolver,
  frames: Map<WindowId, Frame>,
): boolean {
  if (node.kind === "leaf") {
    const constraints = resolve(node.windowId);
    if (
      !withinBounds(rect.width, constraints?.width ?? {}) ||
      !withinBounds(rect.height, constraints?.height ?? {})
    ) {
      return false;
    }
    if (frames.has(node.windowId)) return true; // duplicate ids resolve first-wins
    frames.set(node.windowId, rect);
    return rect.width > 0 && rect.height > 0;
  }
  const component = axisComponent(node.axis);
  const available = rect[component];
  const { first, second, feasible } = partitionLengths(
    available,
    gap,
    node.ratio,
    subtreeBounds(node.first, node.axis, gap, resolve),
    subtreeBounds(node.second, node.axis, gap, resolve),
  );
  if (!feasible) return false;
  const firstRect = shrinkRect(rect, node.axis, first);
  const secondRect = offsetRect(shrinkRect(rect, node.axis, second), node.axis, first + gap);
  return (
    assignFrames(node.first, firstRect, gap, resolve, frames) &&
    assignFrames(node.second, secondRect, gap, resolve, frames)
  );
}

function subtreeBounds(
  node: BspNode,
  axis: SplitAxis,
  gap: number,
  resolve: ConstraintResolver,
): AxisBounds {
  return aggregateBounds(node, axis, gap, resolve);
}

function stackPlan(input: LayoutInput): Map<WindowId, Frame> | null {
  const members = tiledMembers(input.tree);
  const frames = new Map<WindowId, Frame>();
  for (const id of members) {
    const c = input.resolve(id);
    const minW = c?.width?.min;
    const minH = c?.height?.min;
    if ((minW !== undefined && input.content.width < minW) ||
        (minH !== undefined && input.content.height < minH)) {
      return null;
    }
    frames.set(id, input.content);
  }
  return frames;
}

export function overlapPlan(input: LayoutInput): Map<WindowId, Frame> | null {
  const nominal = new Map<WindowId, Frame>();
  const gap = input.gap ?? BSP_DEFAULT_GAP;
  if (!assignFrames(input.tree, input.content, gap, () => ({}), nominal)) return null;

  const frames = new Map<WindowId, Frame>();
  for (const [id, frame] of nominal) {
    const constraints = input.resolve(id);
    const widthBounds = constraints?.width ?? {};
    const heightBounds = constraints?.height ?? {};
    if (
      (widthBounds.min !== undefined &&
        widthBounds.max !== undefined &&
        widthBounds.min > widthBounds.max) ||
      (heightBounds.min !== undefined &&
        heightBounds.max !== undefined &&
        heightBounds.min > heightBounds.max)
    ) {
      return null;
    }

    const width = clampToBounds(frame.width, widthBounds);
    const height = clampToBounds(frame.height, heightBounds);
    if (width <= 0 || height <= 0 || width > input.content.width || height > input.content.height) {
      return null;
    }
    frames.set(id, {
      x: Math.min(
        Math.max(frame.x, input.content.x),
        input.content.x + input.content.width - width,
      ),
      y: Math.min(
        Math.max(frame.y, input.content.y),
        input.content.y + input.content.height - height,
      ),
      width,
      height,
    });
  }
  return frames;
}

function overflowFrames(
  node: BspNode,
  content: Frame,
  gap: number,
  resolve: ConstraintResolver,
): Map<WindowId, Frame> | null {
  const frames = new Map<WindowId, Frame>();
  const grow = (current: Frame, n: BspNode): Frame => {
    if (n.kind === "leaf") return current;
    const comp = axisComponent(n.axis);
    const mins = aggregateBounds(n, n.axis, gap, resolve);
    const required = mins.min;
    if (required !== undefined && current[comp] < required) {
      return { ...current, [comp]: required } as Frame;
    }
    return current;
  };
  const walk = (n: BspNode, rect: Frame): boolean => {
    if (n.kind === "leaf") {
      if (frames.has(n.windowId)) return true;
      const constraints = resolve(n.windowId);
      const widthBounds = constraints?.width ?? {};
      const heightBounds = constraints?.height ?? {};
      const width = clampToBounds(rect.width, widthBounds);
      const height = clampToBounds(rect.height, heightBounds);
      if (
        width <= 0 ||
        height <= 0 ||
        !withinBounds(width, widthBounds) ||
        !withinBounds(height, heightBounds)
      ) {
        return false;
      }
      frames.set(n.windowId, { ...rect, width, height });
      return true;
    }
    const expanded = grow(rect, n);
    const { first, second } = partitionLengths(
      expanded[axisComponent(n.axis)],
      gap,
      n.ratio,
      subtreeBounds(n.first, n.axis, gap, resolve),
      subtreeBounds(n.second, n.axis, gap, resolve),
    );
    if (first <= 0 || second <= 0) return false;
    const firstRect = shrinkRect(expanded, n.axis, first);
    const secondRect = offsetRect(shrinkRect(expanded, n.axis, second), n.axis, first + gap);
    return walk(n.first, firstRect) && walk(n.second, secondRect);
  };
  return walk(node, content) ? frames : null;
}

function tryPolicy(policy: LayoutPolicy, input: LayoutInput): Map<WindowId, Frame> | null {
  const gap = input.gap ?? BSP_DEFAULT_GAP;
  switch (policy) {
    case "greedy": {
      const frames = new Map<WindowId, Frame>();
      return assignFrames(input.tree, input.content, gap, input.resolve, frames) ? frames : null;
    }
    case "overlap": {
      return overlapPlan(input);
    }
    case "stack": {
      return stackPlan(input);
    }
    case "overflow": {
      return overflowFrames(input.tree, input.content, gap, input.resolve);
    }
    case "reject":
      return null;
  }
}

/**
 * Try each policy in order; feasibility is judged ONLY over BSP members
 * (floating windows are not part of the tree). A terminal `reject` policy or
 * exhausted chain yields a rejected plan.
 */
export function planLayout(
  input: LayoutInput,
  policies: readonly LayoutPolicy[] = DEFAULT_POLICY_CHAIN,
): LayoutPlan {
  if (!isFiniteFrame(input.content) || input.content.width <= 0 || input.content.height <= 0) {
    return { feasible: false };
  }
  for (const policy of policies) {
    const frames = tryPolicy(policy, input);
    if (frames !== null) return { feasible: true, policy, frames };
  }
  return { feasible: false };
}
