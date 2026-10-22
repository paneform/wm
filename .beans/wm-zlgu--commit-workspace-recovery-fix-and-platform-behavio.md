---
# wm-zlgu
title: Commit workspace recovery fix and platform behavior doc
status: in-progress
type: task
priority: normal
created_at: 2026-10-13T23:30:10Z
updated_at: 2026-10-14T20:43:28Z
---

User reports the deployed recovery fix appears to work and requests staging/commit plus a subagent conceptual-document first pass.

## Plan
- [x] Record live user feedback and inspect changes/index/history to identify intended commit scope.
- [x] Stage the recovery fix and required dependencies without unrelated local work; validate the staged tree.
- [ ] Review and include the subagent conceptual document and task records.
- [ ] Commit validated changes and verify commit contents and remaining worktree.

## Commit scope

The fix depends on earlier native AX-reference/global-focus/discovery support in the same files. Include that support and its regression tests so the recovery commit is self-contained. Exclude the independent raw-inspection CLI/site feature, key-monitor changes, packaging/version edits and local launch scripts. Shared-file staging uses Git index snapshots; preserve working files. Validate the exact staged snapshot in isolation before committing. The subagent completed docs/rewrite/platform-behavior.md under wm-t3f0; review and commit that conceptual document separately.

## Exact staged-tree validation

Exported the Git index into an isolated temporary workspace and installed locked dependencies from the offline cache. That exact source snapshot passes all1,073 tests (510 layout,150 browser,36 Swift,18 macOS transport,65 CLI,294 site), root lint, typecheck and build. This proves the recovery/focus/discovery commit is self-contained without the unstaged raw-inspection feature. Git diff --cached --check passes. Reviewed staged identity/lifecycle/protocol changes and task records; no secret material is included.

Reviewed the subagent conceptual draft, corrected fallback identity wording to weaker, and generalized its diagnostics paragraph to match the staged implementation. Doc formatting and relative links pass. User feedback is recorded in wm-lao1.

## User follow-up

Move the platform-behavior concept document into the apps/site documentation routes and link it in the navigation rail.

- [x] Move the document into a site docs route and adapt links/metadata to site conventions.
- [x] Add navigation coverage and validate the docs route/navigation before committing the follow-up.

## End-user rewrite

User asks to rewrite the site concept page for end users rather than describe internal APIs and implementation. Explain observable workspace recovery, new-window placement, application size limits, focus, incomplete operations and useful user controls.

- [x] Rewrite the moved page in end-user language and validate its links/rendering.

## Commit organization (2026-10-22)

User asked to organize all local changes into logical commits. Untracked scratch files (test.txt, bundling.sh, cmdtabdebug.sh, debug_hibernate_shuffling.sh) stay untracked by user choice.

Commit series:

1. fix(wm): derive hotkey modifiers from each key-down event — KeyMonitor.swift + KeyMonitorTests.swift.
2. feat(wm): opt-in focus latency trace — FocusLatencyTrace.swift plus instrumentation hunks in Server.swift, InventoryService.swift, GeometryAdapter.swift (index-only patch staging).
3. feat(wm): read-only window observation with AX diagnostics — layout schema/engine/commands/syntax, CLI output, sidecar inspectWindow/inspectApplication over the wire, host adapter, and all tests.
4. docs(wm): observe command and focus reveal documentation in docs/command-interface.md and docs/rewrite/platform-contract.md.
5. docs(site): platform-behavior concept page, navigation links, navigation test, and this bean record.
6. docs(site): observe output explanation on the command page via WindowObservationDetails.svelte.
7. build(wm): CFBundle version stamping from package.json and the new scripts/deploy-local-wm.sh.

Validation of the exact final tree before committing: root lint, typecheck and build pass; pnpm -r test passes (site 304, wm 67, platform-macos transport 21); swift test passes 44 tests including the new KeyMonitor and WindowInspection suites. Status updated after commits verify.
