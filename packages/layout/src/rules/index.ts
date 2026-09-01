import type { Rule } from "./rule.js";
import { ignoreSystemSurfaces } from "./ignore-system-surfaces.js";
import { respectPause } from "./respect-pause.js";
import { pruneDeadMembership } from "./prune-dead-membership.js";
import { restoreMembership } from "./restore-membership.js";
import { assignNewWindows } from "./assign-new-windows.js";
import { transientFollowsParent } from "./transient-follows-parent.js";
import { tileWorkspaces } from "./tile-workspaces.js";
import { clampToCapabilities } from "./clamp-to-capabilities.js";
import { parkInvisibleWorkspaces } from "./park-invisible-workspaces.js";
import { revealFocusedWorkspace } from "./reveal-focused-workspace.js";
import { recoverLostWindows } from "./recover-lost-windows.js";
import { reconcileDrift } from "./reconcile-drift.js";

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

export * from "./rule.js";
