---
# wm-42qq
title: Add global pretty JSON output
status: completed
type: feature
priority: normal
created_at: 2026-08-14T21:54:10Z
updated_at: 2026-08-14T21:55:24Z
---

Add a global --pretty CLI flag and route all stdout through one post-processing pipeline that pretty-prints JSON without command-specific handling.

- [x] Model and parse the global flag
- [x] Add the shared output post-processor
- [x] Cover parsing and all output paths with tests
- [x] Run relevant and full validation

## Summary of Changes

Added a global `--pretty` invocation flag, a single `CLIOutput` stdout post-processing pipeline for pretty JSON, and routed executable verification output through that boundary. Added parser, streaming-output, and non-JSON pass-through tests. Validated with `swift test --filter WMCLITests` and `swift test`.
