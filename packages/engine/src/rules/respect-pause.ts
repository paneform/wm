import type { Action } from "../actions.ts";
import type { World } from "../world.ts";
import type { Rule, RuleContext } from "./rule.ts";

// Rules catalog #2 — when paused, suppress all geometry/parking/focus actions.
// Observation, diagnostics and audits continue (docs/spec.md §Startup…Pause).

export function isSuppressedWhenPaused(action: Action): boolean {
  switch (action.kind) {
    case "setFrame":
    case "setPosition":
    case "focusWindow":
    case "parkWorkspace":
    case "revealWorkspace":
    case "assignWorkspaceDisplay":
      return true;
    default:
      return false;
  }
}

export const respectPause: Rule = {
  name: "respect-pause",
  applies: (world: World): boolean => world.paused,
  run: (): Action[] => [],
};
