---
# wm-dxum
title: Add temporary debug stop inventory
status: completed
type: feature
priority: high
created_at: 2026-08-28T22:27:31Z
updated_at: 2026-08-29T00:26:58Z
---

Add a temporary local CLI command that invokes Engine.stop() without immediately terminating the host and returns concise JSON describing final window identity, frame, and display placement from shutdown readbacks.

## Plan

- [x] Define the compact shutdown report and return it from Engine.stop().
- [x] Add a temporary debug-stop CLI/protocol path that leaves the host queryable.
- [x] Add engine and node-host regression tests.
- [x] Run full validation and exercise the command against the live service.
- [x] Review the diff and document usage.

## Summary of Changes

Added a host-only `debug-stop` command and compact shutdown inventory report. Engine shutdown now interrupts scoped background and in-flight operations before restoring parked windows. The macOS transport queue supports cancellation, duplicate shutdown signals are idempotent, and service stop/restart/install/uninstall restore windows before launchd bootout. Live validation reported `restored=6 failed=0`; after the service exited, all seven sampled windows had visible AX frames. Full tests, lint, typecheck, build, and diff checks pass.

## Follow-up

The temporary `debug-stop` wire and CLI command was removed after diagnosis. Service lifecycle commands now signal the Node child directly and wait for verified Engine.stop restoration before launchd bootout.
