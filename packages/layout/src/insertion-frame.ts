import {
  axisForFrame,
  contentRect,
  firstLeaf,
  findLeaf,
  insertLeaf,
  isEmptyTree,
  planLayout,
  tiledMembers,
  type ConstraintResolver,
} from "./layout/bsp.js";
import type { DisplayObservation, Frame, WindowId } from "./schema.js";
import type { BspNode, SplitAxis, World, WorkspaceState } from "./world.js";

export type InsertionMargins = {
  top?: number | undefined;
  right?: number | undefined;
  bottom?: number | undefined;
  left?: number | undefined;
};

export interface WindowInsertionPlan {
  tree: BspNode;
  beside: WindowId | null;
  axis?: SplitAxis;
  frame: Frame;
}

export interface WindowInsertionInput {
  world: World;
  workspace: WorkspaceState;
  newId: WindowId;
  margins: InsertionMargins;
  gap: number;
  resolve: ConstraintResolver;
  beside?: WindowId | null | undefined;
  axis?: SplitAxis | undefined;
}

/** Plan an insertion without mutating world state. */
export function planWindowInsertion(input: WindowInsertionInput): WindowInsertionPlan | null {
  const { world, workspace, newId, margins, gap, resolve } = input;
  const display = insertionDisplay(world, workspace, undefined);
  if (display === undefined) return null;
  const content = contentRect(display, margins);

  if (isEmptyTree(workspace.tree)) {
    const tree = { kind: "leaf", windowId: newId } as const;
    const plan = planLayout({ tree, content, gap, resolve });
    const frame = plan.feasible ? plan.frames.get(newId) : undefined;
    return frame === undefined ? null : { tree, beside: null, frame };
  }

  const members = tiledMembers(workspace.tree);
  const requestedBeside =
    input.beside == null
      ? (workspace.lastFocusedTiledMember ?? workspace.lastFocusedMember)
      : input.beside;
  const beside =
    (requestedBeside !== null && members.includes(requestedBeside) ? requestedBeside : undefined) ??
    firstLeaf(workspace.tree);
  if (beside === null) return null;

  const current = planLayout({ tree: workspace.tree, content, gap, resolve });
  if (!current.feasible) return null;
  const targetFrame = current.frames.get(beside);
  if (targetFrame === undefined) return null;
  const insertionTree =
    current.policy === "greedy"
      ? retainPathDividers(workspace.tree, beside, current.frames, gap)
      : workspace.tree;

  const preferred = input.axis ?? axisForFrame(targetFrame);
  const axes: readonly SplitAxis[] =
    input.axis === undefined
      ? [preferred, preferred === "vertical" ? "horizontal" : "vertical"]
      : [preferred];
  for (const axis of axes) {
    const tree = insertLeaf(insertionTree, beside, newId, targetFrame, axis);
    if (tree === null) continue;
    const local: BspNode = {
      kind: "split",
      axis,
      ratio: 0.5,
      first: { kind: "leaf", windowId: beside },
      second: { kind: "leaf", windowId: newId },
    };
    if (!planLayout({ tree: local, content: targetFrame, gap, resolve }, ["greedy"]).feasible) {
      continue;
    }
    const plan = planLayout({ tree, content, gap, resolve }, ["greedy"]);
    const frame = plan.feasible ? plan.frames.get(newId) : undefined;
    if (frame !== undefined) return { tree, beside, axis, frame };
  }

  const tree = insertLeaf(workspace.tree, beside, newId, targetFrame, preferred);
  if (tree === null) return null;
  const fallback = planLayout({ tree, content, gap, resolve });
  const frame = fallback.feasible ? fallback.frames.get(newId) : undefined;
  return frame === undefined ? null : { tree, beside, axis: preferred, frame };
}

function retainPathDividers(
  node: BspNode,
  target: WindowId,
  frames: ReadonlyMap<WindowId, Frame>,
  gap: number,
): BspNode {
  if (node.kind === "leaf") return node;
  const targetInFirst = findLeaf(node.first, target);
  const targetInSecond = !targetInFirst && findLeaf(node.second, target);
  if (!targetInFirst && !targetInSecond) return node;

  const firstLength = subtreeLength(node.first, node.axis, frames, gap);
  const secondLength = subtreeLength(node.second, node.axis, frames, gap);
  if (firstLength === null || secondLength === null) return node;
  const available = firstLength + secondLength;
  const ratio =
    Math.floor(available * node.ratio) === firstLength
      ? node.ratio
      : (firstLength + 0.5) / available;
  const child = targetInFirst ? node.first : node.second;
  const retainedChild = retainPathDividers(child, target, frames, gap);
  if (ratio === node.ratio && retainedChild === child) return node;
  return targetInFirst
    ? { ...node, ratio, first: retainedChild }
    : { ...node, ratio, second: retainedChild };
}

function subtreeLength(
  node: BspNode,
  axis: SplitAxis,
  frames: ReadonlyMap<WindowId, Frame>,
  gap: number,
): number | null {
  if (node.kind === "leaf") {
    const frame = frames.get(node.windowId);
    return frame === undefined ? null : axis === "vertical" ? frame.width : frame.height;
  }
  const first = subtreeLength(node.first, axis, frames, gap);
  const second = subtreeLength(node.second, axis, frames, gap);
  if (first === null || second === null) return null;
  return node.axis === axis ? first + gap + second : Math.max(first, second);
}

const overlaps = (a: Frame, b: Frame): boolean =>
  Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
  Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y);

/** Use logical workspace geometry when a physical target frame is parked. */
export function insertionTargetFrame(
  world: World,
  workspace: WorkspaceState,
  targetFrame: Frame | undefined,
  margins: InsertionMargins,
): Frame | undefined {
  const display = insertionDisplay(world, workspace, targetFrame);
  const targetIsVisible =
    workspace.visibleOnDisplay !== null &&
    targetFrame !== undefined &&
    world.topology.displays.some((display) => overlaps(targetFrame, display.workArea));
  if (targetIsVisible) return targetFrame;

  return display === undefined ? targetFrame : contentRect(display, margins);
}

/** Display whose logical content rect governs insertion into this workspace. */
export function insertionDisplay(
  world: World,
  workspace: WorkspaceState,
  targetFrame: Frame | undefined,
): DisplayObservation | undefined {
  if (workspace.visibleOnDisplay !== null && targetFrame !== undefined) {
    const physical = world.topology.displays.find((display) =>
      overlaps(targetFrame, display.workArea),
    );
    if (physical !== undefined) return physical;
  }
  const displayIds = [
    workspace.visibleOnDisplay,
    workspace.pinnedDisplayOverride,
    workspace.preferredDisplay,
  ];
  return (
    displayIds
      .filter((id): id is string => id !== null)
      .map((id) => world.topology.displays.find((candidate) => candidate.id === id))
      .find((candidate) => candidate !== undefined) ??
    world.topology.displays.find((candidate) => candidate.primary) ??
    world.topology.displays[0]
  );
}
