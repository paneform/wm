---
# wm-80bc
title: Classify AX modal windows
status: completed
type: bug
priority: critical
created_at: 2026-08-19T22:33:40Z
updated_at: 2026-08-20T02:13:39Z
---

Collect generic macOS Accessibility modal/relationship signals before lifecycle adoption and classify positive modal or attached windows as transient so they cannot change workspace visibility or layout.

- [x] Extend raw AX inventory with modal, parent, movable, and resizable signals
- [x] Read supported attributes without degrading windows when optional signals are absent
- [x] Classify AXModal and attached windows as transient before lifecycle adoption
- [x] Add inventory and protocol regression coverage
- [ ] Run focused and full validation
- [ ] Restart daemon and live-observe the authorization surface
- [x] Record summary and complete

## Summary of Changes

Extended raw and protocol AX inventory with optional modal, parent, movable, and resizable signals. Windows reporting AXModal or a non-application AX parent are now classified transient before lifecycle adoption, preventing workspace assignment and geometry mutation. Live FileVault observation confirmed the authorization window keeps the focused workspace stable, but coreautha reports AXModal false and no parent, so generic static AX classification does not identify that surface.

Validation: swift test, swift build, git diff --check, daemon restart, and live authorization observation pass.
