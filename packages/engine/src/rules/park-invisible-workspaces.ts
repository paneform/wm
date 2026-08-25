import type { Action } from "../actions.ts";
import { EMPTY_TREE_LEAF, PARKING_ACCEPTANCE_PT } from "../constants.ts";
import type { Frame } from "../schema.ts";
import type { BspNode, World } from "../world.ts";
import { isIgnoredSurface, windowClass } from "./rule.ts";
import type { Rule, RuleContext } from "./rule.ts";

// Rules catalog #9 — windows of non-visible workspaces go to measured
// offscreen corner slots (see parking). Parked intent is durable state in
// workspace.parkedFrames — NEVER inferred from coordinates; a member already
// at its recorded parked frame needs nothing.

export const parkInvisibleWorkspaces: Rule = {
  name: "park-invisible-workspaces",
  applies: (world: World, ctx: RuleContext): boolean =>
    scanForPending(world, ctx).pending,
  run: (world: World, ctx: RuleContext): Action[] => {
    const actions: Action[] = [];
    for (const workspace of world.workspaces.values()) {
      if (workspace.visibleOnDisplay !== null || workspace.name === world.focusedWorkspace) continue;
      if (memberNeedsPark(world, ctx, workspace)) {
        actions.push({ kind: "parkWorkspace", workspace: workspace.name });
      }
    }
    return actions;
  },
};

function scanForPending(world: World, ctx: RuleContext): { pending: boolean } {
  for (const workspace of world.workspaces.values()) {
    if (
      workspace.visibleOnDisplay === null &&
      workspace.name !== world.focusedWorkspace &&
      memberNeedsPark(world, ctx, workspace)
    ) {
      return { pending: true };
    }
  }
  return { pending: false };
}

function memberNeedsPark(
  world: World,
  ctx: RuleContext,
  workspace: {
    name: string;
    visibleOnDisplay: string | null;
    tree: BspNode;
    floating: ReadonlySet<string>;
    parkedFrames: ReadonlyMap<string, Frame>;
  },
): boolean {
  let pending = false;
  const checkMember = (id: string): void => {
    if (pending || id === EMPTY_TREE_LEAF) return;
    const observation = world.windows.get(id);
    if (observation === undefined) return;
    if (observation.minimized || observation.hidden) return;
    if (isIgnoredSurface(world, ctx, observation)) return;
    if (windowClass(observation) === "transient") return;
    const intent = workspace.parkedFrames.get(id);
    if (intent !== undefined && framesMatch(observation.frame, intent)) return;
    pending = true;
  };

  collectLeaves(workspace.tree, checkMember);
  for (const id of workspace.floating) checkMember(id);
  return pending;
}

function framesMatch(observed: Frame, intent: Frame): boolean {
  return (
    Math.abs(observed.x - intent.x) <= PARKING_ACCEPTANCE_PT &&
    Math.abs(observed.y - intent.y) <= PARKING_ACCEPTANCE_PT &&
    Math.abs(observed.width - intent.width) <= PARKING_ACCEPTANCE_PT &&
    Math.abs(observed.height - intent.height) <= PARKING_ACCEPTANCE_PT
  );
}

function collectLeaves(node: BspNode, visit: (id: string) => void): void {
  if (node.kind === "leaf") {
    visit(node.windowId);
    return;
  }
  collectLeaves(node.first, visit);
  collectLeaves(node.second, visit);
}
