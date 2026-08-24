import type { Action } from "../actions.ts";
import type { World } from "../world.ts";
import { primaryDisplay } from "./rule.ts";
import type { Rule, RuleContext } from "./rule.ts";

// Rules catalog #10 — ensure the focused workspace's display shows it.
// Revealing on another display parks the destination's previous workspace and
// keeps the moved workspace focused (executor semantics for RevealWorkspace).

export const revealFocusedWorkspace: Rule = {
  name: "reveal-focused-workspace",
  applies: (world: World): boolean => world.focusedWorkspace !== null,
  run: (world: World, _ctx: RuleContext): Action[] => {
    if (world.focusedWorkspace === null) return [];
    const workspace = world.workspaces.get(world.focusedWorkspace);
    if (workspace === undefined) return [];

    const desired =
      workspace.pinnedDisplayOverride ??
      workspace.preferredDisplay ??
      primaryDisplay(world)?.id ??
      null;
    if (desired === null || desired === workspace.visibleOnDisplay) return [];

    return [{ kind: "revealWorkspace", workspace: workspace.name, displayId: desired }];
  },
};
