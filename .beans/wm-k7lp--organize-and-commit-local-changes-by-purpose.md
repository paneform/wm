---
# wm-k7lp
title: Organize and commit local changes by purpose
status: in-progress
type: task
priority: normal
created_at: 2026-10-02T18:04:20Z
updated_at: 2026-10-02T18:16:40Z
---

Review the complete working tree and commit the requested local source changes in logical, validated groups. Preserve all existing user work; exclude generated artifacts and external local configuration.

## Plan

- [x] Review all tracked/untracked source changes and identify shared-file staging boundaries.
- [x] Commit Developer ID packaging defaults and ignore the generated root Swift cache.
- [ ] Commit full-extent directional stack exchange with its regression scenario.
- [ ] Commit focused-window styling and compact demo-card presentation.
- [ ] Commit per-display workspace indicators and animation/browser checks.
- [ ] Commit the shared command grammar, JSON contracts and caller/example migrations.
- [ ] Commit compact CLI output, app metadata and verbose diagnostics.
- [ ] Commit command-hierarchy docs navigation.
- [ ] Commit updated design references and remaining formatting-only changes.
- [ ] Validate commit groups, run final checks and verify the working tree is clean.

Each commit includes this tracking bean (and relevant existing beans when useful), matches the conventional commit style, and is inspected before committing. No push requested.

## Review and staging boundaries

The root .build directory contains only generated Swift cache files and is now ignored. Shared files (command schemas, CLI entrypoint, docs pages, demo stage and browser checks) will be staged via Git index snapshots so parser/contracts, compact output and navigation remain independently coherent. Working source files are preserved. Existing issue reports are included where relevant; only selected beans are added despite the tracker ignore rule.

Packaging syntax and root cache exclusion checks pass. Developer ID selection was also exercised by the approved signed deployment earlier in this session.

## Commit 1

b58123b — build(wm): default local app packaging to Developer ID signing. Includes the generated root Swift cache ignore and packaging issue report.
