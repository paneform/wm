---
# wm-sk2k
title: Add CLI help command
status: completed
type: feature
priority: normal
created_at: 2026-08-14T22:39:07Z
updated_at: 2026-08-14T22:40:44Z
---

Add `wm help` and `wm --help` output with command descriptions, nested subcommands and flags, and root-level global flags.

- [x] Inspect the current CLI command grammar and tests
- [x] Implement structured help output and dispatch
- [x] Add or update automated tests
- [x] Run relevant and full validation
- [x] Summarize the completed changes

## Summary of Changes

Added a first-class local help command available through both `wm help` and `wm --help`. The structured output documents every root command, nested subcommand, positional argument, command-specific flag, and the global `--pretty` flag. Added parser and runner coverage, verified both executable forms, and passed the focused CLI tests, full test suite, build, and diff checks.
