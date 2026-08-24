import { dedupeActions, type Action } from "../actions.ts";
import type { BspNode, World } from "../world.ts";
import type { Rule } from "./rule.ts";

// Rules catalog #3 — remove closed/destroyed windows from membership + BSP;
// the executor collapses their parent node promoting the sibling subtree.

export const pruneDeadMembership: Rule = {
  name: "prune-dead-membership",
  applies: (world: World): boolean => {
    for (const workspace of world.workspaces.values()) {
      for (const id of allMembers(workspace)) {
        if (!world.windows.has(id)) return true;
      }
    }
    return false;
  },
  run: (world: World): Action[] => {
    const dead = new Set<string>();
    for (const workspace of world.workspaces.values()) {
      for (const id of allMembers(workspace)) {
        if (!world.windows.has(id)) dead.add(id);
      }
    }
    return dedupeActions(
      [...dead].map((windowId) => ({ kind: "removeWindow", windowId }) as Action),
    );
  },
};

function allMembers(workspace: { tree: BspNode; floating: ReadonlySet<string> }): string[] {
  const ids = new Set<string>();
  collectLeaves(workspace.tree, ids);
  for (const id of workspace.floating) ids.add(id);
  return [...ids];
}

function collectLeaves(node: BspNode, into: Set<string>): void {
  if (node.kind === "leaf") {
    into.add(node.windowId);
    return;
  }
  collectLeaves(node.first, into);
  collectLeaves(node.second, into);
}
