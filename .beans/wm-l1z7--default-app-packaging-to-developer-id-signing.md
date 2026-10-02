---
# wm-l1z7
title: Default app packaging to Developer ID signing
status: completed
type: bug
priority: normal
created_at: 2026-09-12T21:21:02Z
updated_at: 2026-09-12T21:21:58Z
---

## Plan

- [x] Default packaging to Developer ID Application: Allan Deutsch (WCW44PJWTC), retaining explicit identity overrides.
- [x] Update signing instructions and validate script syntax and certificate selection.

Do not package, restart services, or modify permissions as part of this script update.

## Summary of Changes

Packaging now defaults to the exact Developer ID Application name for team WCW44PJWTC. The dedicated local keychain is used only when WM Local Code Signing is explicitly selected; there is no implicit fallback. Exact-name/fingerprint overrides and ambiguity rejection remain. Updated operations documentation and missing-identity guidance.

Validation: bash -n passed; security find-identity confirms exactly one matching Developer ID identity; documentation formatted with Oxfmt; git diff --check passed. Packaging and service restart were not run, so the installed app remains unchanged and end-to-end signing awaits the next approved build.
