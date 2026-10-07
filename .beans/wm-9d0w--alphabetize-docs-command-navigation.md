---
# wm-9d0w
title: Alphabetize docs command navigation
status: completed
type: task
priority: normal
created_at: 2026-10-06T06:15:57Z
updated_at: 2026-10-07T17:26:32Z
---

## Plan

- [x] Sort sidebar command groups and nested commands alphabetically.
- [x] Verify ordering and run site checks.

## Summary of Changes

Replaced fixed command-group ranking with recursive alphabetical sorting by label at every level of the docs command navigation. Added a regression test checking every sibling list.

## Validation

Focused navigation tests: 6 passed. Full site suite: 294 tests passed across 37 files. Site lint, typecheck (zero errors/warnings), production build, formatter, and whitespace checks passed.

## Command casing

- [x] Display original lowercase command tokens in navigation and validate.

### Command casing summary

CommandNavigation now renders the original CLI token for links and branch labels, matching lowercase command syntax at every level. Typecheck passed with zero errors/warnings and whitespace checks passed.

## Summary of Changes — Overview link

Added Overview as the first Getting started sidebar item, linking to /wm/docs/, with active styling and mobile menu close behavior. Site typecheck passed with no errors/warnings; whitespace checks passed.
