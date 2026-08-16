---
# wm-9rae
title: Optimize directional window move effects
status: todo
type: task
priority: normal
created_at: 2026-08-16T18:22:25Z
updated_at: 2026-08-16T18:22:29Z
---

Apply the direct layout/movement effect optimization used by wm-9wo9 to `wm window move DIRECTION`: compute the final layout before effects, move cooperative windows directly to final frames without redundant intermediate geometry, preserve verified transactional rollback and workspace invariants, and add deterministic and live tests.\n\n## Acceptance\n\n- [ ] Compute final directional layout before applying geometry.\n- [ ] Move cooperative windows directly without redundant intermediate frames.\n- [ ] Preserve verified atomic rollback and workspace invariants.\n- [ ] Add deterministic and live tests.
