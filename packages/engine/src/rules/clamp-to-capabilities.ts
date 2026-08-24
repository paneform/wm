import type { Action } from "../actions.ts";
import { DEFAULT_POLICY_CHAIN } from "../constants.ts";
import { contentRect, constraintsResolver, planLayout, tiledMembers } from "../layout/bsp.ts";
import type { World } from "../world.ts";
import {
  constraintsForWindow,
  displayById,
  isIgnoredSurface,
  windowClass,
} from "./rule.ts";
import type { Rule, RuleContext } from "./rule.ts";

// Rules catalog #8 — before SetFrame executes: intersect the request with
// known/viable learned min/max constraints. When no feasible frame exists for
// a tiled window under any policy, float it and emit a degradation diagnostic.
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
      const display =
        displayById(world, workspace.visibleOnDisplay);
      if (display === undefined) continue;
      const settings = ctx.settings(workspace.name);

      const resolver = constraintsResolver((id) => {
        const obs = world.windows.get(id);
        return obs === undefined ? {} : constraintsForWindow(world, ctx, obs);
      });
      const plan = planLayout(
        {
          tree: workspace.tree,
          content: contentRect(display, settings.margins),
          gap: settings.gap,
          resolve: resolver,
        },
        DEFAULT_POLICY_CHAIN,
      );

      if (!plan.feasible) {
        // Rejected plan: no policy could place these members — degrade all.
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
        continue;
      }

      // Feasible plan but under a relaxed policy ⇒ members whose viable
      // minimums cannot be honored degrade to floating.
      if (plan.policy !== "greedy") {
        for (const [id] of plan.frames) {
          const observation = world.windows.get(id);
          if (observation === undefined || isIgnoredSurface(world, ctx, observation)) continue;
          if (windowClass(observation) !== "normal") continue;
          const c = constraintsForWindow(world, ctx, observation);
          const violated =
            (c.minWidth !== undefined && plan.frames.get(id)!.width < c.minWidth) ||
            (c.minHeight !== undefined && plan.frames.get(id)!.height < c.minHeight);
          if (violated) {
            actions.push({ kind: "floatWindow", windowId: id });
            actions.push({
              kind: "emitDiagnostic",
              code: "layout_infeasible_float",
              detail: `window ${id}: min size unsatisfiable in ${workspace.name}`,
            });
          }
        }
      }
    }
    return actions;
  },
};
