---
# wm-juzm
title: Use more playground space for simulated devices
status: completed
type: task
priority: normal
created_at: 2026-09-16T22:14:38Z
updated_at: 2026-09-16T22:33:18Z
---

- [x] Measure stage/laptop bounds and identify excess space above devices.
- [x] Tighten stage/header spacing and grow devices responsively without changing shared laptop geometry.
- [x] Verify single/linked layouts at desktop, tablet, mobile, and short landscape sizes; run relevant checks.

## Keyboard Scaling Follow-up

- [x] Investigate physical keyboard/keycap viewport versus container sizing and align playground scaling with the hero.
- [x] Verify key presentation at small linked-laptop sizes without regressing hero or Settings keycaps.

## Tray Corner Clearance

- [x] Prevent corner keys from overlapping the keyboard tray edge at small sizes by making tray rounding/clearance scale appropriately.

User reports corner-key overlap on small keyboards and suggests a smaller tray radius.

Found viewport-based key depth/radius/padding and compact media query, plus inherited font sizing. Physical keyboards now own a named inline-size container, descendant fonts/shape variables scale with cqi, and compact labels use a keyboard-container query. Stage min-height removed, wrapper envelope tightened, devices enlarged, player widened. Tray fixed8px radius replaced by proportional local percentages to prevent small corner-key overlap.

## Summary of Changes

Widened the playground and enlarged devices, removed stage minimum-height whitespace, reduced heading/stage padding, and tightened the projected laptop wrapper on large/tall screens. Measured desktop laptop width grew by about34%; title-to-lid gap at1280x800 fell from69px to19px. Physical key font/geometry now scale with a named keyboard container, and compact key presentation responds to keyboard width rather than viewport. Screen keycaps keep independent em sizing. Keyboard tray corner radius now scales proportionally to its own dimensions instead of fixed8px.

Validation: 232 site tests, lint, Svelte/typecheck, and production build passed. Browser verified single/comparison layouts across desktop/tablet/mobile/shortlandscape, keyboard-only resizing at fixed viewport, hero mobile, Settings keycaps, and actual220/300/400px laptop tray corners atDPR2/3. Corner clearance remains at least1.35px in measured cases, so no additional padding was needed. No clipping, overflow, or browser errors observed. Report: /var/folders/km/jth9jsgn24lfrsvvp9sjzrqr0000gn/T/opencode/final-corners/report.json.
