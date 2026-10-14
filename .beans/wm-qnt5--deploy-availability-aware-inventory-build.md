---
# wm-qnt5
title: Deploy availability-aware inventory build
status: completed
type: task
priority: normal
created_at: 2026-10-13T08:54:55Z
updated_at: 2026-10-13T19:48:47Z
---

Deploy the completed wm-lao1 source fix to the running local wm service while preserving live state and privacy grants.

## Plan

- [x] Capture service PID, health, permissions, window inventory, process instances, and workspace memberships
- [x] Build a fresh release sidecar and package/install wm.app with the existing Developer ID identity
- [x] Verify the installed bundle signature and packaged protocol before service disruption
- [x] Reload the launchd service only after packaging succeeds
- [x] Validate the new PID, health, permissions, inventory/instanceId protocol, and baseline workspace preservation
- [x] Restore only known baseline OpenSCAD memberships if needed and safe, then document results

## Summary of Changes

Built the Swift sidecar in release mode, packaged and installed wm.app using the existing Developer ID Application identity, verified the strict deep signature and designated requirement, then restarted the launchd service. Host PID changed from 812 to 85644 and the Node child is 85683. Service state is healthy and both Accessibility and Screen Recording remain granted.

The new read-only inventory returns stable instanceId values; Bambu remained PID 63083, window window:cg:1177, instance DCF91DC8-132B-4703-8713-AA3BCC791619:5, workspace T. All baseline window IDs retained their memberships. OpenSCAD was not running before or after deployment, so no restoration was possible or needed. Newly observed ChatGPT and transient Problem Reporter windows were not modified. No applications were activated, relaunched, minimized, restored, or moved manually. Actual sleep/wake validation remains a follow-up because sleep was not simulated or forced.
