---
# wm-zlgu
title: Commit workspace recovery fix and platform behavior doc
status: in-progress
type: task
priority: normal
created_at: 2026-10-13T23:30:10Z
updated_at: 2026-10-14T20:12:09Z
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
