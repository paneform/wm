import type { Action, InsertWindowAction } from "../actions.js";
import type { World } from "../world.js";
import { findMembership, restorableMembership } from "./rule.js";
import type { Rule, RuleContext } from "./rule.js";

// Rules catalog #4 — matching returning instances restore prior workspace
// membership after sleep/wake/inventory loss. Highest placement precedence:
// runs before assign-new-windows so returning windows keep their home.

export const restoreMembership: Rule = {
  name: "restore-membership",
  applies: (world: World, ctx: RuleContext): boolean => {
    for (const [id] of ctx.tombstones) {
      if (ctx.overrides.unmanaged.has(id)) continue;
      const window = world.windows.get(id);
      if (window === undefined || restorableMembership(world, ctx, window) === undefined) continue;
      if (findMembership(world, id) !== null) continue;
      return true;
    }
    return false;
  },
  run: (world: World, ctx: RuleContext): Action[] => {
    const actions: Action[] = [];
    for (const [id] of ctx.tombstones) {
      if (ctx.overrides.unmanaged.has(id)) continue;
      const window = world.windows.get(id);
      if (window === undefined) continue;
      const tombstone = restorableMembership(world, ctx, window);
      if (tombstone === undefined) continue;
      if (findMembership(world, id) !== null) continue;
      if (!world.workspaces.has(tombstone.workspace)) continue;
      const base: InsertWindowAction = {
        kind: "insertWindow",
        windowId: id,
        workspace: tombstone.workspace,
      };
      let action: InsertWindowAction;
      if (tombstone.anchor !== null) {
        action = tombstone.floating
          ? { ...base, beside: tombstone.anchor, floating: true }
          : { ...base, beside: tombstone.anchor };
      } else {
        action = tombstone.floating ? { ...base, floating: true } : base;
      }
      actions.push(action);
    }
    return actions;
  },
};
