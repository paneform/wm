---
# wm-bbds
title: Deploy updated wm.app binary
status: completed
type: task
priority: high
created_at: 2026-09-02T22:47:45Z
updated_at: 2026-09-02T22:52:57Z
---

Build and activate the current working-tree pause hotkey changes in the installed wm.app.

Plan:
- [x] Build the Swift sidecar in release mode.
- [x] Package and install the signed local wm.app.
- [x] Restart the launchd-managed wm service.
- [x] Verify the active process, installed executable, and service state.
- [x] Record the deployment result and close the bean.

## Summary of Changes

- Built the Swift sidecar in release mode.
- Installed the signed app at /Users/allan/.local/libexec/wm/wm.app.
- Restarted com.paneform.wm through /Users/allan/.local/bin/wm.
- Verified launchd state, active executable path, healthy WM state, and app signature.
- The current shell does not include /Users/allan/.local/bin in PATH, so the absolute launcher path was required.
