---
# wm-yws8
title: Investigate 3D windows losing workspace after wake
status: completed
type: bug
priority: normal
created_at: 2026-10-10T08:16:39Z
updated_at: 2026-10-10T08:19:34Z
---

User reports OpenSCAD and Bambu Studio moving to the active workspace after sleep/wake.

## Plan
- [x] Trace wake, inventory removal/reappearance, and membership restoration paths.
- [x] Collect read-only live diagnostics and validate the suspected cause.
- [x] Record findings, impact, and mitigation with evidence.

## Findings

### 1. Temporary inventory loss is treated as closure

Locations: packages/platform-macos/sidecar/Sources/wm-sidecar/WindowSource.swift:180-200, InventoryService.swift:168-216 and225-234; packages/layout/src/rules/prune-dead-membership.ts:19-27. An AX enumeration timeout omits that application from the normalized inventory; filtering or AX/CG join failure can also omit windows. Native diff emits window_removed for any missing entry, without proof of destruction. Engine pruning removes missing membership. Impact: a live application can lose its assigned workspace merely because it cannot be observed. Mitigation: distinguish unavailable observation from confirmed closure, preserve trusted membership/identity during recovery, and address Bambu minimized subrole filtering already established in wm-yvq7.

### 2. Workspace memory expires after five wall-clock minutes

Locations: packages/layout/src/engine.ts:192,757-773,1598-1600; apps/wm/src/clock-node.ts:6; packages/layout/src/rules/assign-new-windows.ts:35-40,54-60,122-136. Removal creates a tombstone keyed by the exact window ID. Records expire after five minutes using Date.now(), including elapsed sleep. Returning windows without a record use affinity then focused workspace. Current config has no affinity for OpenSCAD or Bambu; several other applications do. Impact: longer inventory loss makes these returning windows join whichever workspace is active. Mitigation: preserve prior placement for a verified same live window across sleep/unavailability; avoid only increasing the TTL or matching by title, which can conflate genuinely new windows. Explicit app assignment is an optional workaround if a fixed home workspace is desired.

Validation: a temporary two-case engine simulation kept the fake application/window alive and its ID unchanged while omitting its inventory observation, with home3 and activeC. Four minutes restored3; six minutes reassignedC. Both cases passed using pnpm exec vitest run test/wake-membership-diagnostic.spec.ts. Removed the temporary diagnostic test after use; no production code changed. Installed Resources/cli.mjs:48105,48526,49114 confirms the deployed five-minute TTL and both deletion paths, not just working-tree behavior.

### 3. Current sleep/wake handling has no protected recovery phase

Locations: packages/layout/src/engine.ts:5392-5407; InventoryService.swift:276-280. Sleep/wake increments topology-event generation and requests ordinary reconciliation; wake immediately refreshes inventory. It does not pause management, wait for stable window inventory, or suspend tombstone expiry. The older completed Swift session-resynchronization bean describes an earlier implementation, not this current engine. Impact: partial inventories during transitions can be used as membership input. Mitigation: introduce transition-aware observation recovery and retain committed placement while window facts are unavailable.

## Live evidence and limits

At2026-10-10T08:17Z, installed signed observer PID84033 has Accessibility and ScreenRecording=true; service healthy, unpaused, activeC. OpenSCAD PID54828/window:cg:30781 and Bambu PID65900/window:cg:29904 are both assignedC, registered, normal nonminimized windows, readable through granted native diagnostics. These are the same IDs recorded before this report; OpenSCAD was previously restored to3 per wm-yvq7. Neither app is globally focused; app-local AXFocused=true does not itself explain assignment.

~/.local/state/wm/diagnostics.jsonl:1283,1287 records Bambu main PID65900 AX stall at2026-10-09T23:53:59.374Z and recovery at2026-10-10T00:04:05.318Z (over ten minutes). Lines1335,1350,1914 record OpenSCAD30781 removal signals with unavailable inventories; lines1950-1986 repeat30781 removals during failed reconciliation. Bambu29904 removal signals also occur at1320,1363,1831. Some full-zero inventories are explicitly rejected, so removal signals alone do not prove membership was pruned in those particular passes. The log does not record successful assignment/tombstone transitions or sleep notifications. Thus the loss/expiry/fallback mechanism is code-confirmed and reproduced; the exact native rejection and timing that caused each reported real-machine move are not fully captured. Do not claim that every logged removal caused reassignment, that minimizing caused this sleep event, or that a GPU reset has been proven.

## Summary of Changes

Completed a read-only investigation, checked deployed code and privileged current observations, identified inventory-loss/expiry/fallback defects, and validated the four-versus-six-minute behavior with two passing simulation cases. Recorded findings and mitigation here as the single investigation report. No app activation, geometry changes, deployment, daemon restart, or production-code changes were performed. Further live sleep capture and a source fix remain follow-up work.
