---
# wm-k9ff
title: Implement per-window floating behavior
status: todo
type: feature
priority: high
created_at: 2026-08-16T07:09:47Z
updated_at: 2026-08-16T07:09:47Z
---

Implement true floating-window state and effects independent of workspace layout mode. System Settings should be configurable as floating by default, while an explicit tiled matcher opts it into BSP and bounded uncooperative-window policies. Include lifecycle membership, focus, movement, persistence, config schema, floating geometry, and live verification.\n\n## Acceptance\n\n- [ ] Represent tiled versus floating behavior per window in persisted workspace state.\n- [ ] Add workspace-local/default matcher behavior without restoring top-level rules.\n- [ ] Keep floating windows focusable and associated with a workspace without BSP leaves.\n- [ ] Make moves into floating workspaces avoid BSP geometry writes.\n- [ ] Default System Settings to floating in the live config after implementation.\n- [ ] Add deterministic and live tests.
