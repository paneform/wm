import type { Action } from "../actions.js";
import { DEFAULT_TOLERANCE } from "../constants.js";
import { withinTolerance } from "../geometry.js";
import type { World } from "../world.js";
import { plannedTiledFrames } from "./rule.js";
import type { Rule, RuleContext } from "./rule.js";

// Rules catalog #7 — for each visible BSP workspace with members: compute
// constraint-aware BSP frames (see layout math) and emit SetFrame per member
// whose observed frame disagrees. Members floated by rule 8 leave the tree
// before the next pass, so they are excluded naturally.

export const tileWorkspaces: Rule = {
  name: "tile-workspaces",
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
      const frames = plannedTiledFrames(world, ctx, workspace);
      if (frames === null) continue;
      for (const [windowId, frame] of frames) {
        const observation = world.windows.get(windowId);
        if (observation === undefined) continue;
        // Hidden/minimized members keep their slot but receive no geometry.
        if (observation.minimized || observation.hidden) continue;
        if (!withinTolerance(observation.frame, frame, DEFAULT_TOLERANCE)) {
          actions.push({ kind: "setFrame", windowId, frame });
        }
      }
    }
    return actions;
  },
};
