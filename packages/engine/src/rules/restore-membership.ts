import type { Action } from "../actions.ts";
import type { World } from "../world.ts";
import { findMembership } from "./rule.ts";
import type { Rule, RuleContext } from "./rule.ts";

// Rules catalog #4 — known replacement identities restore prior workspace
// membership after sleep/wake/inventory loss. Highest placement precedence:
// runs before assign-new-windows so returning windows keep their home.

export const restoreMembership: Rule = {
  name: "restore-membership",
  applies: (world: World, ctx: RuleContext): boolean => {
    for (const [id] of ctx.tombstones) {
      if (!world.windows.has(id)) continue;
      if (findMembership(world, id) !== null) continue;
      return true;
    }
    return false;
  },
  run: (world: World, ctx: RuleContext): Action[] => {
    const actions: Action[] = [];
    for (const [id, tombstone] of ctx.tombstones) {
      if (!world.windows.has(id)) continue;
      if (findMembership(world, id) !== null) continue;
      if (!world.workspaces.has(tombstone.workspace)) continue;
      actions.push({
        kind: "insertWindow",
        windowId: id,
        workspace: tombstone.workspace,
        ...(tombstone.anchor !== null ? { beside: tombstone.anchor } : {}),
        ...(tombstone.floating ? { floating: true } : {}),
      });
    }
    return actions;
  },
};
