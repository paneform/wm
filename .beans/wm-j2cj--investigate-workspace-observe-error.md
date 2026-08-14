---
# wm-j2cj
title: Investigate workspace observe error
status: completed
type: bug
created_at: 2026-08-14T19:09:03Z
updated_at: 2026-08-14T19:09:03Z
---

Investigate the reported error from `wm observe workspace 1`.

- [x] Reproduce the error
- [x] Confirm workspace existence and request parsing
- [x] Identify the running daemon version/process
- [x] Report root cause and remediation

## Summary of Changes

Reproduced `invalid_message`. Workspace `1` exists and the current CLI builds `observe.workspace` correctly. The daemon listening on port 17832 started at 11:41, before the feature was compiled around 12:06, so its protocol decoder does not know the new method. Restarting the daemon with the rebuilt executable is required.
