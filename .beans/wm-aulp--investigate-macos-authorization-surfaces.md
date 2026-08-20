---
# wm-aulp
title: Investigate macOS authorization surfaces
status: completed
type: task
priority: normal
created_at: 2026-08-19T20:50:22Z
updated_at: 2026-08-19T20:52:15Z
---

Identify stable behavioral and Accessibility characteristics of macOS authentication/authorization surfaces without relying on app-specific bundle IDs.

- [x] Capture baseline inventory before the FileVault prompt
- [x] Capture inventory while the authorization prompt is visible
- [x] Compare observations and identify generalized classification signals
- [x] Restore workspace T
- [x] Record findings and recommended handling

## Summary of Changes

Observed the FileVault authorization surface before, during, and after presentation. The visible surface was `coreautha` (`com.apple.LocalAuthentication.UIAgent`) at 260x306, centered on the display, focused/main, and reported misleadingly as `AXWindow` / `AXStandardWindow`. Its appearance parked both managed workspace windows and macOS rejected frame changes until dismissal. The binary carries `com.apple.private.DFRSystemModalPresentation`, but that entitlement is not exposed through the current inventory.

Recommended handling: do not infer system-modal status solely from size, centering, focus, or standard AX role because ordinary dialogs can share those traits. Introduce a trusted system-modal host classification based on Apple-signed LocalAuthentication/CoreAuthentication executables or bundle family, then suspend workspace activation, parking, reconciliation, and focus correction while one is visible. Treat the behavioral signature (new focused system-hosted compact overlay plus frame-write rejection) as confirmation/recovery, not the primary classifier.
