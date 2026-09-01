import type { Action } from "../actions.js";
import type { World } from "../world.js";
import { primaryDisplay } from "./rule.js";
import type { Rule, RuleContext } from "./rule.js";

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

    // A visible workspace is already revealed. Display affinity selects where
    // to restore a parked workspace; it must not relocate one on every pass.
    if (
      workspace.visibleOnDisplay !== null &&
      world.topology.displays.some((display) => display.id === workspace.visibleOnDisplay)
    ) {
      return [];
    }

    const connected = (id: string | null): string | null =>
      id !== null && world.topology.displays.some((display) => display.id === id) ? id : null;
    const desired =
      connected(workspace.pinnedDisplayOverride) ??
      connected(workspace.preferredDisplay) ??
      primaryDisplay(world)?.id ??
      null;
    if (desired === null) return [];

    return [{ kind: "revealWorkspace", workspace: workspace.name, displayId: desired }];
  },
};
