import { constraintsResolver } from "../layout/bsp.js";
import type { Action } from "../actions.js";
import { recordFocusedMember, type World } from "../world.js";
import { planWindowInsertion } from "../insertion-frame.js";
import {
  constraintsForWindow,
  displayById,
  findMembership,
  isIgnoredSurface,
  matchAffinity,
  primaryDisplay,
  windowClass,
} from "./rule.js";
import type { Rule, RuleContext } from "./rule.js";

// Rules catalog #5 — placement precedence for unassigned managed windows:
// configured affinity matcher → focused workspace → workspace "1" only when
// nothing is focused/visible. Detection alone NEVER changes focus.
//
// Pre-insertion preflight (engine-guide §rules 5): the intended frame is
// computed WITHOUT mutating committed state; the SetFrame is emitted BEFORE
// the InsertWindow so the executor's stop-on-first-failure ordering verifies
// geometry before tree membership. On preflight failure the window stays
// quarantined (unmanaged) and the pass retries later.

export const assignNewWindows: Rule = {
  name: "assign-new-windows",
  applies: (world: World, ctx: RuleContext): boolean => {
    for (const observation of world.windows.values()) {
      if (startupQuarantine(ctx).has(observation.id)) continue;
      if (
        !isIgnoredSurface(world, ctx, observation) &&
        findMembership(world, observation.id) === null
      ) {
        const tombstone = ctx.tombstones.get(observation.id);
        if (
          tombstone !== undefined &&
          ctx.now - tombstone.at <= 5 * 60 * 1000 &&
          world.workspaces.has(tombstone.workspace)
        )
          continue;
        return true;
      }
    }
    return false;
  },
  run: (world: World, ctx: RuleContext): Action[] => {
    const actions: Action[] = [];
    let prospective = world;
    for (const observation of world.windows.values()) {
      if (startupQuarantine(ctx).has(observation.id)) continue;
      if (isIgnoredSurface(world, ctx, observation)) continue;
      if (findMembership(world, observation.id) !== null) continue;
      const tombstone = ctx.tombstones.get(observation.id);
      if (
        tombstone !== undefined &&
        ctx.now - tombstone.at <= 5 * 60 * 1000 &&
        world.workspaces.has(tombstone.workspace)
      )
        continue;
      // Only normal windows are auto-placed; transients follow parents (rule 6).
      if (windowClass(observation) === "transient") continue;

      const target = pickWorkspace(world, ctx, observation);
      if (target === null) continue;
      const workspace = prospective.workspaces.get(target);
      if (workspace === undefined) continue;

      const display =
        displayById(world, workspace.visibleOnDisplay) ??
        displayById(world, workspace.pinnedDisplayOverride) ??
        displayById(world, workspace.preferredDisplay) ??
        primaryDisplay(world);
      if (display === undefined) {
        actions.push({
          kind: "emitDiagnostic",
          code: "assign_no_display",
          detail: `window ${observation.id}: no display available`,
        });
        continue;
      }

      const plan = preflightInsertion(prospective, ctx, workspace.name, observation.id, display.id);
      if (plan === null) {
        // No feasible intended frame — quarantine (emit nothing) for retry.
        actions.push({
          kind: "emitDiagnostic",
          code: "assign_preflight_infeasible",
          detail: `window ${observation.id}: no feasible frame in ${target}`,
        });
        continue;
      }

      actions.push({ kind: "setFrame", windowId: observation.id, frame: plan.frame });
      const insertion = {
        kind: "insertWindow",
        windowId: observation.id,
        workspace: target,
      } as const;
      if (plan.beside === null) actions.push(insertion);
      else if (plan.axis === undefined) actions.push({ ...insertion, beside: plan.beside });
      else actions.push({ ...insertion, beside: plan.beside, axis: plan.axis });
      // Later discoveries must split the tree that earlier verified insertions will commit.
      prospective = {
        ...prospective,
        workspaces: new Map(prospective.workspaces).set(target, { ...workspace, tree: plan.tree }),
      };
      prospective = recordFocusedMember(prospective, prospective.focusIntent?.id ?? null);
    }
    return actions;
  },
};

const EMPTY_QUARANTINE: ReadonlySet<string> = new Set();
const startupQuarantine = (ctx: RuleContext): ReadonlySet<string> => {
  if (!("startupQuarantine" in ctx) || !(ctx.startupQuarantine instanceof Set)) {
    return EMPTY_QUARANTINE;
  }
  return ctx.startupQuarantine;
};

export function pickWorkspace(
  world: World,
  ctx: RuleContext,
  observation: import("../schema.js").WindowObservation,
): string | null {
  const affinity = matchAffinity(world, ctx, observation);
  if (affinity !== null) return affinity;

  if (world.focusedWorkspace !== null && world.workspaces.has(world.focusedWorkspace)) {
    return world.focusedWorkspace;
  }

  const anyVisible = [...world.workspaces.values()].some((ws) => ws.visibleOnDisplay !== null);
  if (!anyVisible && world.workspaces.has("1")) return "1";
  return null;
}

/** Hypothetical insert + solve WITHOUT mutating committed state. */
function preflightInsertion(
  world: World,
  ctx: RuleContext,
  workspaceName: string,
  newId: string,
  displayId: string,
) {
  const workspace = world.workspaces.get(workspaceName);
  if (workspace === undefined) return null;
  const display = displayById(world, displayId);
  if (display === undefined) return null;
  const settings = ctx.settings(workspaceName, display.id);

  const resolver = constraintsResolver((id) => {
    if (id === newId) return constraintsForWindow(world, ctx, observation0(world, newId));
    const obs = world.windows.get(id);
    return obs === undefined ? {} : constraintsForWindow(world, ctx, obs);
  });

  return planWindowInsertion({
    world,
    workspace,
    newId,
    margins: settings.margins,
    gap: settings.gap,
    resolve: resolver,
  });
}

function observation0(world: World, id: string) {
  return world.windows.get(id)!;
}
