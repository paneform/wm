---
# wm-t3f0
title: Document imperfect platform behavior model
status: completed
type: task
priority: normal
created_at: 2026-10-13T23:16:34Z
updated_at: 2026-10-14T20:40:43Z
---

Write a concise conceptual document grounded in the current implementation.

## Plan

- [x] Check existing documentation for overlap and inspect platform, lifecycle, geometry, probe, and transaction behavior.
- [x] Draft docs/rewrite/platform-behavior.md, separating implemented behavior from limits and unimplemented ideas.
- [x] Format the document and verify links, source claims, owned-file scope, and git diff hygiene.
- [x] Record a summary and complete the bean.

## Summary of Changes

Added `docs/rewrite/platform-behavior.md`, an 833-word conceptual guide grounded in the current portable platform contract, engine lifecycle, geometry retry and learning behavior, transaction compensation, and macOS lifetime tracking. It distinguishes unavailable observations from closure, remembered intent from actionable facts, and implemented behavior from explicit limits. Included sleep/wake and geometry/focus examples. Formatted with oxfmt and verified links, source claims, diff whitespace, scope, and unstaged status.

## Parent review

Reviewed the draft against the exact staged recovery implementation. Clarified that fallback identity is weaker, distinguished physical non-atomic operations from verified intent commits, and limited the evidence guarantee. Generalized diagnostics wording to avoid requiring the independent unstaged raw-inspection feature. Formatter and relative-link/source checks pass.
