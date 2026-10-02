---
# wm-k7lp
title: Organize and commit local changes by purpose
status: in-progress
type: task
priority: normal
created_at: 2026-10-02T18:04:20Z
updated_at: 2026-10-02T18:49:20Z
---

Review the complete working tree and commit the requested local source changes in logical, validated groups. Preserve all existing user work; exclude generated artifacts and external local configuration.

## Plan

- [x] Review all tracked/untracked source changes and identify shared-file staging boundaries.
- [x] Commit Developer ID packaging defaults and ignore the generated root Swift cache.
- [x] Commit full-extent directional stack exchange with its regression scenario.
- [x] Commit focused-window styling and compact demo-card presentation.
- [x] Commit per-display workspace indicators and animation/browser checks.
- [x] Commit the shared command grammar, JSON contracts and caller/example migrations.
- [x] Commit compact CLI output, app metadata and verbose diagnostics.
- [ ] Commit command-hierarchy docs navigation.
- [ ] Commit updated design references and remaining formatting-only changes.
- [ ] Validate commit groups, run final checks and verify the working tree is clean.

Each commit includes this tracking bean (and relevant existing beans when useful), matches the conventional commit style, and is inspected before committing. No push requested.

## Review and staging boundaries

The root .build directory contains only generated Swift cache files and is now ignored. Shared files (command schemas, CLI entrypoint, docs pages, demo stage and browser checks) will be staged via Git index snapshots so parser/contracts, compact output and navigation remain independently coherent. Working source files are preserved. Existing issue reports are included where relevant; only selected beans are added despite the tracker ignore rule.

Packaging syntax and root cache exclusion checks pass. Developer ID selection was also exercised by the approved signed deployment earlier in this session.

## Commit 1

b58123b — build(wm): default local app packaging to Developer ID signing. Includes the generated root Swift cache ignore and packaging issue report.

## Commit 2

dfd729e — fix(layout): exchange full-span windows with adjacent stacks. Includes the three-window reference scenario and geometric regression tests. All 26 geometric tests and 47 docs checks pass.

## Commit 3

18958c0 — style(site): clarify window focus and compact demo cards. Staged only focus colors, adaptive card sizing, single-example pip hiding and their browser assertions. Carousel/caption checks pass.

## Commit 4

48de325 — fix(site): keep docs workspace indicators on their owning displays. Includes ownership/animation helpers, fixture support and six scenario tests. Browser-check paths in this commit use the then-current command catalog; the command migration updates them next.

A newer local service-start demo edit appeared during organization (three overlapping windows). Preserve it and validate its expectations before including it with the scenario updates.

## Contracts staging validation

Exported the staged index to an isolated temporary workspace and installed only cached locked dependencies. The exact staged command/contracts tree passes all 1,003 TypeScript/Swift tests, root lint, typechecks and production/native builds. This verifies the split without relying on unstaged compact-output or navigation code. The newer service-start and explicit-ID focus demo edits also pass scenario expectations in that staged tree.

## Commit 5

ee4cbb3 — refactor(wm): unify public command grammar and JSON contracts. Includes canonical namespace/Result parsing, independent assignment targets/follow behavior, internal-only APIs, adapters and scenario/caller migrations. Its exact staged tree passes tests, lint, typecheck and build in isolation.

## Compact-output staging validation

The exact staged compact-output tree passes all 1,014 TypeScript/Swift tests, root lint, typechecks and production/native builds in the isolated index workspace. The contracts commit and this output commit are therefore independently buildable; pending navigation code was not used for either validation.

## Commit 6

a3d9db7 — feat(wm): provide compact command output and verbose diagnostics. Includes authoritative listing/app metadata, native name propagation, concise formatting, global verbose flag, client integration tests and output documentation. Its exact staged tree passes all checks in isolation.

## Navigation staging validation

The exact staged navigation tree passes all 284 site tests, site lint, typecheck and production build in the isolated index workspace. It includes the grammar-derived sidebar/index, concise breadcrumbs/search labels and host-command destinations.
