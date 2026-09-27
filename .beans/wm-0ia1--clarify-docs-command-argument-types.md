---
# wm-0ia1
title: Clarify docs command argument types
status: completed
type: task
priority: normal
created_at: 2026-09-27T19:19:39Z
updated_at: 2026-09-27T19:24:55Z
parent: wm-fgbj
---

Plan: trace actual window/workspace argument semantics, add a correct optional-window example to the move-workspace mockup, and propose a concise reusable type-reference design grounded in the grammar.

- [x] Inspect command syntax and validation for window and workspace arguments
- [x] Add a correct optional-window example and clarify the arguments table
- [x] Record a type-reference recommendation in the design spec
- [x] Verify example syntax and documentation consistency

## Findings (grammar and validation)

- `packages/layout/src/command-syntax.ts:163-190,360-379`: the explicit window is not an optional token in `window move workspace <workspace>`. It is a separate `workspace move-window <window-id> <workspace>` path. Impact: the mockup implies an optional argument that cannot be passed to the displayed command. Mitigation: show both invocations and a concrete explicit-ID example.
- `packages/layout/src/engine.ts:3860-3916,4133-4164` and `:1841-1882`: the focused form follows the moved window, while the explicit-ID form moves it without changing focus; both can create a new workspace. Impact: examples should distinguish behavior so readers do not expect follow-on focus from the explicit form. Mitigation: note the difference beside the syntax.
- `packages/layout/src/command-syntax.ts:12-20,79-108,280-295,451-491` plus `packages/layout/src/commands.ts:54-112,531-541`: grammar slots already have semantic kinds (`window`, `workspace`, `display`, `coordinate`, `dimension`) and an `allowNew` flag; direction is a closed literal enum. CLI paths require nonempty argument tokens, allow quoted whitespace, and window IDs must resolve to observed windows (else `window_not_found`). Wire schemas use `Schema.String`, so CLI validation and runtime lookup must be documented separately. Impact: `slot` is a grammar role and `name` is too vague as a public type. Mitigation: link precise reusable type names from command tables to a small shared type reference, while keeping command-specific requiredness/creation behavior on each command page.

## Summary of Changes

Updated the move-to-workspace mockup to show both focused spellings and the separate explicit-ID CLI form with `wm workspace move-window w1 writing`, an ID lookup hint (`wm windows`), and the distinction that this form does not follow the moved window. Replaced `slot`/`name` as displayed types with linked `Window ID`/`Workspace name` labels and stated that an ID is required only for the explicit form. Updated the design spec to group the two engine commands correctly and propose a shared argument-types reference page with stable anchors, source-of-truth metadata, validation layers, and per-command requiredness rules. Verified the syntax with 10 passing command-syntax tests; browser-checked the example, links, and lack of horizontal overflow at 375/833/1121/1280px. `git diff --check` passed.
