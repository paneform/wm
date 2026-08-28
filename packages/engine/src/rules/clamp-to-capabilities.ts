import type { Action } from "../actions.ts";
import { contentRect, constraintsResolver, planLayout, tiledMembers } from "../layout/bsp.ts";
import type { World } from "../world.ts";
import { constraintsForWindow, displayById, isIgnoredSurface } from "./rule.ts";
import type { Rule, RuleContext } from "./rule.ts";

// Rules catalog #8 — before SetFrame executes: intersect the request with
// known/viable learned min/max constraints. When no policy can place the BSP,
// float its members and emit degradation diagnostics.
// Feasibility is judged ONLY over BSP members (floating excluded).

export const clampToCapabilities: Rule = {
  name: "clamp-to-capabilities",
  applies: (world: World): boolean => {
    for (const workspace of world.workspaces.values()) {
      if (workspace.visibleOnDisplay !== null && workspace.mode === "bsp") return true;
    }
    return false;
  },
  run: (world: World, ctx: RuleContext): Action[] => {
    const actions: Action[] = [];
    for (const workspace of world.workspaces.values()) {
      if (workspace.visibleOnDisplay === null || workspace.mode !== "bsp") continue;
      const display = displayById(world, workspace.visibleOnDisplay);
      if (display === undefined) continue;
      const settings = ctx.settings(workspace.name, display.id);

      const resolver = constraintsResolver((id) => {
        const obs = world.windows.get(id);
        return obs === undefined ? {} : constraintsForWindow(world, ctx, obs);
      });
      const plan = planLayout({
        tree: workspace.tree,
        content: contentRect(display, settings.margins),
        gap: settings.gap,
        resolve: resolver,
      });

      if (!plan.feasible) {
        for (const id of tiledMembers(workspace.tree)) {
          const observation = world.windows.get(id);
          if (observation === undefined || isIgnoredSurface(world, ctx, observation)) continue;
          actions.push({ kind: "floatWindow", windowId: id });
          actions.push({
            kind: "emitDiagnostic",
            code: "layout_infeasible_float",
            detail: `window ${id}: layout rejected in ${workspace.name}`,
          });
        }
      }
    }
    return actions;
  },
};
