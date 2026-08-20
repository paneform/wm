---
# wm-6nc2
title: Observe authorization workspace switch
status: completed
type: bug
priority: critical
created_at: 2026-08-19T22:29:58Z
updated_at: 2026-08-19T22:30:27Z
---

Observe the FileVault/password authorization UI under the rebuilt daemon, determine why focus changed from workspace T to S, and identify generic modal signals without moving or focusing windows during capture.

- [x] Capture immediate workspace and inventory state
- [x] Capture authorization-visible state after two seconds
- [x] Compare focus, membership, classification, and geometry effects
- [x] Record findings and next implementation step

## Summary of Changes

Observed the authorization surface as focused `window:cg:3449`, `AXWindow` / `AXStandardWindow`, 260x306 at (626,205). Lifecycle promoted its normal classification to managed, auto-adopted it into fallback workspace `1` alongside Safari, and external-focus reconciliation activated workspace `1`. That parked both members of workspace T. The reported T-to-S transition was transient or visual; the captured committed destination was workspace `1`.

Raw inventory reports management as unmanaged because normalization does not decide lifecycle ownership; the workspace observation confirms expected management was managed. This is the direct cause.

Next implementation step: collect generic AX modal and relationship/capability attributes before classification, beginning with `AXModal`, `AXParent`, and movability/resizability/window controls. Classify positive modal/attached signals as transient before lifecycle adoption. Do not use compact centered geometry alone.
