---
# wm-culo
title: Remove temporary debug-stop command
status: completed
type: task
priority: normal
created_at: 2026-08-29T00:23:23Z
updated_at: 2026-08-29T00:26:58Z
---

Remove the temporary debug-stop CLI/wire command and command-specific tests. Replace wm-service lifecycle use with direct graceful signaling of the Node child, validate live restoration, run full checks, and commit the intended work.

## Plan

- [x] Remove debug-stop from schemas, CLI parsing, routing, output handling, and tests.
- [x] Replace service-script debug-stop use with bounded direct child shutdown.
- [x] Validate live stop restoration and run full tests, lint, typecheck, build, and diff checks.
- [x] Stage the intended worktree changes and prepare the commit.

## Summary of Changes

Removed the temporary `debug-stop` command from the schema, CLI, host routing, output handling, help, and tests. Service stop/restart/install/uninstall now signal the Node child directly, wait up to 60 seconds for Effect-managed shutdown restoration, and only then boot out launchd. Live validation restored five parked windows with zero failures and left all sampled windows visible after WM exited. Full tests, lint, typecheck, build, and diff checks pass.
