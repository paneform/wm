import type { Action } from "../actions.js";
import type { World } from "../world.js";
import { findMembership, isIgnoredSurface, windowClass } from "./rule.js";
import type { Rule, RuleContext } from "./rule.js";

// Rules catalog #6 — dialogs/sheets float in their parent's workspace (else
// the focused one); they are stationary: never parked or tiled.

export const transientFollowsParent: Rule = {
  name: "transient-follows-parent",
  applies: (world: World, ctx: RuleContext): boolean => {
    for (const observation of world.windows.values()) {
      if (
        windowClass(observation) === "transient" &&
        !isIgnoredSurface(world, ctx, observation) &&
        findMembership(world, observation.id) === null
      ) {
        return true;
      }
    }
    return false;
  },
  run: (world: World, ctx: RuleContext): Action[] => {
    const actions: Action[] = [];
    for (const observation of world.windows.values()) {
      if (windowClass(observation) !== "transient") continue;
      if (isIgnoredSurface(world, ctx, observation)) continue;
      if (findMembership(world, observation.id) !== null) continue;

      const parent = findParent(world, observation);
      const target = parent !== null ? membershipWorkspace(world, parent) : world.focusedWorkspace;
      if (target === null || !world.workspaces.has(target)) continue;

      actions.push({
        kind: "insertWindow",
        windowId: observation.id,
        workspace: target,
        floating: true,
      });
    }
    return actions;
  },
};

/** Prefer the focused managed window of the same pid as the transient. */
function findParent(
  world: World,
  transient: import("../schema.js").WindowObservation,
): string | null {
  let fallback: string | null = null;
  for (const candidate of world.windows.values()) {
    if (candidate.id === transient.id) continue;
    if (candidate.pid !== transient.pid) continue;
    const membership = findMembership(world, candidate.id);
    if (membership === null || membership.floating === false) {
      if (candidate.focused) return candidate.id;
      fallback ??= candidate.id;
    }
  }
  return fallback;
}

function membershipWorkspace(world: World, windowId: string): string | null {
  for (const workspace of world.workspaces.values()) {
    if (workspace.floating.has(windowId)) return workspace.name;
    if (includesLeaf(workspace.tree, windowId)) return workspace.name;
  }
  return null;
}

function includesLeaf(node: import("../world.js").BspNode, id: string): boolean {
  if (node.kind === "leaf") return node.windowId === id;
  return includesLeaf(node.first, id) || includesLeaf(node.second, id);
}
