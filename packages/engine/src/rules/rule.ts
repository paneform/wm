import type { Config, EffectiveWorkspaceSettings } from "../config.ts";
import type { Action } from "../actions.ts";
import type { Constraints, DisplayId, Frame, WindowId, WindowObservation } from "../schema.ts";
import {
  classify,
  type BspNode,
  type Profile,
  type ProfileKey,
  type World,
  type WorkspaceState,
} from "../world.ts";
import { DEFAULT_TOLERANCE, REPLAN_BONUS } from "../constants.ts";
import { contentRect, constraintsResolver, planLayout, tiledMembers } from "../layout/bsp.ts";
import { effectiveConstraints, makeProfileKey, type ConstraintAxis } from "../learn.ts";
import { withinTolerance } from "../geometry.ts";
import { effectiveSettings } from "../config.ts";

// Shared rule infrastructure. Rules are pure functions over the World
// snapshot emitting Actions — NO I/O happens inside a rule.

export interface TombstoneRecord {
  workspace: string;
  floating: boolean;
  /** Exact pre-removal BSP topology, used when its surviving members still match. */
  tree: BspNode;
  parkedFrame: Frame | null;
  /** Split partner to re-insert beside, when known. */
  anchor: WindowId | null;
  at: number;
}

export interface ManagedOverrides {
  /** Explicit `manage` — overrides classification (spec §Window Rules). */
  readonly managed: ReadonlySet<WindowId>;
  /** Explicit `unmanage` — lasts for the logical window's lifetime. */
  readonly unmanaged: ReadonlySet<WindowId>;
}

export interface RuleContext {
  config: Config;
  now: number;
  tombstones: ReadonlyMap<WindowId, TombstoneRecord>;
  overrides: ManagedOverrides;
  contextFingerprint: string;
  settings(workspaceName: string, displayId?: DisplayId): EffectiveWorkspaceSettings;
  globalSettings(): EffectiveWorkspaceSettings;
}

export interface Rule {
  name: string;
  applies(world: World, ctx: RuleContext): boolean;
  run(world: World, ctx: RuleContext): Action[];
}

// ---------------------------------------------------------------------------
// Classification-aware predicates (rule 1 anchors these)
// ---------------------------------------------------------------------------

/** System/uncertain surfaces: ignored unless explicitly managed. */
export function isIgnoredSurface(
  _world: World,
  ctx: RuleContext,
  observation: WindowObservation,
): boolean {
  if (ctx.overrides.managed.has(observation.id)) return false;
  const cls = classify(observation);
  return cls === "system" || cls === "uncertain";
}

export function windowClass(observation: WindowObservation): string {
  return classify(observation);
}

// ---------------------------------------------------------------------------
// Membership helpers
// ---------------------------------------------------------------------------

export function findMembership(
  world: World,
  windowId: WindowId,
): { workspace: WorkspaceState; floating: boolean } | null {
  for (const workspace of world.workspaces.values()) {
    if (tiledMembers(workspace.tree).includes(windowId)) {
      return { workspace, floating: false };
    }
    if (workspace.floating.has(windowId)) return { workspace, floating: true };
  }
  return null;
}

export function allMemberIds(world: World): Set<WindowId> {
  const ids = new Set<WindowId>();
  for (const workspace of world.workspaces.values()) {
    for (const id of tiledMembers(workspace.tree)) ids.add(id);
    for (const id of workspace.floating) ids.add(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------

export function displayById(world: World, displayId: DisplayId | null) {
  if (displayId === null) return undefined;
  return world.topology.displays.find((d) => d.id === displayId);
}

export function primaryDisplay(world: World) {
  return world.topology.displays.find((d) => d.primary) ?? world.topology.displays[0];
}

// ---------------------------------------------------------------------------
// Profiles & constraints
// ---------------------------------------------------------------------------

export function profileKeyOf(
  observation: WindowObservation,
  contextFingerprint: string,
): ProfileKey | null {
  const application = observation.bundleId ?? observation.executablePath;
  if (application === undefined) return null;
  return makeProfileKey({
    application,
    role: observation.role,
    subrole: observation.subrole,
    contextFingerprint,
  });
}

export function profileOf(
  world: World,
  ctx: RuleContext,
  observation: WindowObservation,
): Profile | null {
  const key = profileKeyOf(observation, ctx.contextFingerprint);
  if (key === null) return null;
  const keyStr = [key.application, key.role, key.subrole ?? "", key.contextFingerprint].join(
    "\u0000",
  );
  return world.profiles.get(keyStr) ?? null;
}

export function constraintsForWindow(
  world: World,
  ctx: RuleContext,
  observation: WindowObservation,
): Constraints {
  const profile = profileOf(world, ctx, observation);
  return effectiveConstraints(observation.constraints, profile?.constraints, observation.frame);
}

// ---------------------------------------------------------------------------
// Layout planning
// ---------------------------------------------------------------------------

/**
 * Planned tiled frames for a visible BSP workspace, honoring margins/gap and
 * viable constraints. Returns null when the workspace cannot be planned
 * (not visible, display gone, or rejected plan).
 */
export function plannedTiledFrames(
  world: World,
  ctx: RuleContext,
  workspace: WorkspaceState,
): Map<WindowId, Frame> | null {
  if (workspace.mode !== "bsp") return null;
  if (workspace.visibleOnDisplay === null) return null;
  const display = displayById(world, workspace.visibleOnDisplay);
  if (display === undefined) return null;
  const settings = ctx.settings(workspace.name, display.id);
  const content = contentRect(display, settings.margins);
  const resolver = constraintsResolver((id) => {
    const obs = world.windows.get(id);
    return obs === undefined ? {} : constraintsForWindow(world, ctx, obs);
  });
  const plan = planLayout({
    tree: workspace.tree,
    content,
    gap: settings.gap,
    resolve: resolver,
  });
  return plan.feasible ? new Map(plan.frames) : null;
}

export const FRAME_TOLERANCE = DEFAULT_TOLERANCE;
export const DRIFT_REPLAN_BOUND_BASE = REPLAN_BONUS;

export function frameDiffers(a: Frame, b: Frame): boolean {
  return !withinTolerance(a, b, DEFAULT_TOLERANCE);
}

// ---------------------------------------------------------------------------
// Affinity matcher (config §initial assignment matchers)
// ---------------------------------------------------------------------------

function matchesValue(actual: string | undefined, pattern: string, op: MatchOp): boolean {
  if (actual === undefined) return false;
  switch (op) {
    case "exact":
      return actual.toLowerCase() === pattern.toLowerCase();
    case "contains":
      return actual.toLowerCase().includes(pattern.toLowerCase());
    case "regex":
      try {
        return new RegExp(pattern).test(actual);
      } catch {
        return false;
      }
  }
}

type MatchOp = "exact" | "contains" | "regex";

/** First workspace whose structured `assign` matchers hit, else null. */
export function matchAffinity(
  world: World,
  ctx: RuleContext,
  observation: WindowObservation,
): string | null {
  for (const workspace of world.workspaces.values()) {
    const settings = ctx.settings(workspace.name);
    for (const entry of settings.assign) {
      const matched =
        (entry.bundleId !== undefined &&
          matchesValue(observation.bundleId, entry.bundleId, "exact")) ||
        (entry.executablePath !== undefined &&
          matchesValue(observation.executablePath, entry.executablePath, "exact")) ||
        (entry.title !== undefined && matchesValue(observation.title, entry.title, "regex")) ||
        (entry.role !== undefined && matchesValue(observation.role, entry.role, "exact")) ||
        (entry.subrole !== undefined && matchesValue(observation.subrole, entry.subrole, "exact"));
      if (matched) return workspace.name;
    }
  }
  return null;
}

export type { ConstraintAxis };
