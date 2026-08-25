import { insertLeaf, firstLeaf, planLayout, contentRect, tiledMembers, constraintsResolver, isEmptyTree } from "../layout/bsp.ts";
import type { Action } from "../actions.ts";
import type { Frame } from "../schema.ts";
import type { World } from "../world.ts";
import { insertionTargetFrame } from "../insertion-frame.ts";
import {
  constraintsForWindow,
  displayById,
  findMembership,
  isIgnoredSurface,
  matchAffinity,
  primaryDisplay,
  windowClass,
} from "./rule.ts";
import type { Rule, RuleContext } from "./rule.ts";

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
      if (!isIgnoredSurface(world, ctx, observation) && findMembership(world, observation.id) === null) {
        const tombstone = ctx.tombstones.get(observation.id);
        if (
          tombstone !== undefined &&
          ctx.now - tombstone.at <= 5 * 60 * 1000 &&
          world.workspaces.has(tombstone.workspace)
        ) continue;
        return true;
      }
    }
    return false;
  },
  run: (world: World, ctx: RuleContext): Action[] => {
    const actions: Action[] = [];
    for (const observation of world.windows.values()) {
      if (isIgnoredSurface(world, ctx, observation)) continue;
      if (findMembership(world, observation.id) !== null) continue;
      const tombstone = ctx.tombstones.get(observation.id);
      if (
        tombstone !== undefined &&
        ctx.now - tombstone.at <= 5 * 60 * 1000 &&
        world.workspaces.has(tombstone.workspace)
      ) continue;
      // Only normal windows are auto-placed; transients follow parents (rule 6).
      if (windowClass(observation) === "transient") continue;

      const target = pickWorkspace(world, ctx, observation);
      if (target === null) continue;
      const workspace = world.workspaces.get(target);
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

      const frame = preflightFrame(world, ctx, workspace.name, observation.id, display.id);
      if (frame === null) {
        // No feasible intended frame — quarantine (emit nothing) for retry.
        actions.push({
          kind: "emitDiagnostic",
          code: "assign_preflight_infeasible",
          detail: `window ${observation.id}: no feasible frame in ${target}`,
        });
        continue;
      }

      actions.push({ kind: "setFrame", windowId: observation.id, frame });
      actions.push({ kind: "insertWindow", windowId: observation.id, workspace: target });
    }
    return actions;
  },
};

function pickWorkspace(
  world: World,
  ctx: RuleContext,
  observation: import("../schema.ts").WindowObservation,
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
function preflightFrame(
  world: World,
  ctx: RuleContext,
  workspaceName: string,
  newId: string,
  displayId: string,
): Frame | null {
  const workspace = world.workspaces.get(workspaceName);
  if (workspace === undefined) return null;
  const display = displayById(world, displayId);
  if (display === undefined) return null;
  const settings = ctx.settings(workspaceName);

  const members = tiledMembers(workspace.tree);
  const beside =
    (workspace.lastFocusedMember !== null && members.includes(workspace.lastFocusedMember)
      ? workspace.lastFocusedMember
      : members[0]) ?? null;
  const observedBesideFrame = beside === null ? undefined : world.windows.get(beside)?.frame;
  const besideFrame = insertionTargetFrame(world, workspace, observedBesideFrame, settings.margins);
  const hypothetical = isEmptyTree(workspace.tree)
    ? ({ kind: "leaf", windowId: newId } as const)
    : beside !== null && besideFrame !== undefined
      ? insertLeaf(workspace.tree, beside, newId, besideFrame)
      : null;
  if (hypothetical === null) return null;

  const resolver = constraintsResolver((id) => {
    if (id === newId) return constraintsForWindow(world, ctx, observation0(world, newId));
    const obs = world.windows.get(id);
    return obs === undefined ? {} : constraintsForWindow(world, ctx, obs);
  });

  const plan = planLayout({
    tree: hypothetical,
    content: contentRect(display, settings.margins),
    gap: settings.gap,
    resolve: resolver,
  });
  if (!plan.feasible) return null;
  return plan.frames.get(newId) ?? null;
}

function observation0(world: World, id: string) {
  return world.windows.get(id)!;
}
