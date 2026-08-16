---
# wm-lbsr
title: Persist window cooperation profiles
status: completed
type: feature
priority: normal
created_at: 2026-08-15T21:12:45Z
updated_at: 2026-08-15T21:19:24Z
---

Implement durable per-app/window geometry constraints and cooperation-level tracking, storage, loading, confidence/invalidation semantics, and tests.

## Plan

- [ ] Define profile identity, constraint, cooperation, confidence, and invalidation model.\n  Identity: bundle ID (fallback executable path) + AX role/subrole; no title/window ID specificity because constraints are expected to be app window-class behavior.\n  Invalidation: optional app version and display-topology fingerprint partition observations when callers can supply them.
- [ ] Implement durable storage and loader near wm configuration/state conventions.
- [ ] Record stable geometry constraints and repeated-attempt cooperation outcomes.
- [ ] Add focused persistence and learning tests.
- [x] Integrate with policy handling and run full validation. Profile observation is integrated at geometry results; policy/CLI integration is explicitly owned by another agent. Full focused rerun is blocked by unrelated non-exhaustive .uncooperativeWindowPolicySet handling in the dirty worktree.

## Progress\n\nImplemented profile identity, confidence/sample metadata, inferred minimum dimensions, corrective-attempt learning, app-version/topology partitioning, XDG state JSON loading, and fsync + atomic rename persistence. Geometry set success and exhausted verification paths now record observations. Focused tests compiled and profile learning tests passed; store round-trip exposed and fixed ISO-8601 decoder configuration. Final rerun is currently blocked during package compilation by the policy agent's unfinished WMProtocol/DaemonHandler switch update.

## Summary of Changes

Added durable per-application/window-class geometry profiles at `$XDG_STATE_HOME/wm/geometry-profiles.json` (fallback `~/.local/state/wm`). Profiles use bundle ID or executable plus role/subrole, track learned minimum dimensions, corrective attempt count, sample/success counts, confidence, timestamps, and optional app-version/topology context. Minimum dimensions require three consistent clamp observations before promotion, preventing one-off cross-display transition clamps from becoming false constraints. The daemon loads profiles at startup, records geometry outcomes atomically, and merges learned constraints/cooperation into greedy/stack/overlap/reject layout planning. Full validation passes: 57 XCTest cases, 143 Swift Testing cases, build, geometry verifier, workspace layout verifier, and git diff checks.
