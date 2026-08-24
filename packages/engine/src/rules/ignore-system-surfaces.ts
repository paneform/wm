import type { World } from "../world.ts";
import type { Action } from "../actions.ts";
import type { Rule, RuleContext } from "./rule.ts";

// Rules catalog #1 — docs/rewrite/engine-guide.md §Rules catalog.
// Windows classified transient/system/uncertain are never managed: no
// geometry actions ever target them. Emits nothing; gates everything else
// through isIgnoredSurface().

export const ignoreSystemSurfaces: Rule = {
  name: "ignore-system-surfaces",
  applies: (_world: World, _ctx: RuleContext): boolean => true,
  run: (): Action[] => [],
};
