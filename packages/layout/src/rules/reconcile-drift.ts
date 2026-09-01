import type { Action } from "../actions.js";
import { DEFAULT_TOLERANCE, REPLAN_BONUS } from "../constants.js";
import { withinTolerance } from "../geometry.js";
import type { World } from "../world.js";
import { plannedTiledFrames } from "./rule.js";
import type { Rule, RuleContext } from "./rule.js";

// Rules catalog #12 — observed frames disagreeing with committed intent
// (beyond attribution) trigger bounded repair via the same transaction path
// as commands. Replan bound per layout pass: memberCount + 1.

export const reconcileDrift: Rule = {
  name: "reconcile-drift",
  applies: (world: World): boolean => world.epoch >= 0,
  run: (world: World, ctx: RuleContext): Action[] => {
    const actions: Action[] = [];
    for (const workspace of world.workspaces.values()) {
      if (workspace.visibleOnDisplay === null || workspace.mode !== "bsp") continue;
      const frames = plannedTiledFrames(world, ctx, workspace);
      if (frames === null) continue;
      // Bounded repair: memberCount + REPLAN_BONUS per layout pass.
      const bound = frames.size + REPLAN_BONUS;
      let emitted = 0;
      for (const [windowId, frame] of frames) {
        if (emitted >= bound) break;
        const observation = world.windows.get(windowId);
        if (observation === undefined || observation.minimized || observation.hidden) continue;
        if (!withinTolerance(observation.frame, frame, DEFAULT_TOLERANCE)) {
          actions.push({ kind: "setFrame", windowId, frame });
          emitted += 1;
        }
      }
    }
    return actions;
  },
};
