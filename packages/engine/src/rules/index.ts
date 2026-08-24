import type { Rule } from "./rule.ts";
import { ignoreSystemSurfaces } from "./ignore-system-surfaces.ts";
import { respectPause } from "./respect-pause.ts";
import { pruneDeadMembership } from "./prune-dead-membership.ts";
import { restoreMembership } from "./restore-membership.ts";
import { assignNewWindows } from "./assign-new-windows.ts";
import { transientFollowsParent } from "./transient-follows-parent.ts";
import { tileWorkspaces } from "./tile-workspaces.ts";
import { clampToCapabilities } from "./clamp-to-capabilities.ts";
import { parkInvisibleWorkspaces } from "./park-invisible-workspaces.ts";
import { revealFocusedWorkspace } from "./reveal-focused-workspace.ts";
import { recoverLostWindows } from "./recover-lost-windows.ts";
import { reconcileDrift } from "./reconcile-drift.ts";

// Ordered rule list — docs/rewrite/engine-guide.md §Rules catalog.
export const RULES: readonly Rule[] = [
  ignoreSystemSurfaces,
  respectPause,
  pruneDeadMembership,
  restoreMembership,
  assignNewWindows,
  transientFollowsParent,
  tileWorkspaces,
  clampToCapabilities,
  parkInvisibleWorkspaces,
  revealFocusedWorkspace,
  recoverLostWindows,
  reconcileDrift,
];

export * from "./rule.ts";
