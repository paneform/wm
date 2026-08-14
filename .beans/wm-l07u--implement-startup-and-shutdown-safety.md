---
# wm-l07u
title: Implement startup and shutdown safety
status: completed
type: feature
priority: critical
created_at: 2026-08-14T18:58:47Z
updated_at: 2026-08-14T21:43:37Z
---

Scope: startup audit, graceful shutdown, pause/resume, permission revocation, and crash recovery.

Acceptance:
- Validate permissions/config and acquire an atomic per-user lock before readiness.
- Audit loaded committed state against observed windows and repair drift before ready.
- Restore parked workspaces on graceful shutdown and runtime permission revocation.
- Implement pause/resume with structured errors and full reconciliation on resume.
- Recover last committed intent rather than interrupted effects after crash.

## Implementation Plan

- [x] Inspect current startup, persistence, permission, and shutdown behavior.
- [x] Implement atomic per-user locking, readiness audit, and committed-state recovery.
- [x] Implement graceful shutdown, permission-revocation restoration, pause, and resume reconciliation.
- [x] Add focused coverage for lifecycle safety and structured failures.
- [x] Run targeted and full validation.
- [x] Record encountered bugs and summarize changes.

## Bugs Encountered

- `Sources/wm/DaemonHandler.swift` and `Sources/wm/DaemonLifecycle.swift`: the initial patch missed handler insertion anchors and exposed `Method`/`WorkspaceState` name collisions with AppKit and WMProtocol. Impact: executable target did not compile. Resolution: inserted lifecycle methods at exact anchors and qualified `WMProtocol.Method` and `WMWorkspace.WorkspaceState`; targeted and full builds pass.
- `Tests/WMDaemonTests/DaemonLifecycleTests.swift`: the first recovery fixture assumed one visible workspace globally, but workspace visibility is per display. Impact: deterministic audit assertions were invalid. Resolution: modeled a second display and asserted committed visible-workspace reconciliation.

## Summary of Changes

- Added an atomic XDG-state per-user `flock` lock acquired before readiness.
- Gated readiness on Accessibility and Screen Recording capability checks, then audited loaded committed workspace intent against live inventory before starting the server.
- Added committed-intent restore/retile reconciliation for startup and resume, plus parked-window restoration on graceful shutdown and runtime permission revocation.
- Added `pause`/`resume` CLI and protocol commands, structured `paused` and permission errors, mutation gating, and full refresh/audit before resume.
- Added deterministic lock, lifecycle, committed-intent recovery, and CLI mapping tests.
- Validation run: targeted lifecycle/lock/CLI tests, full `swift test` (102 tests), `swift build`, and `git diff --check` all pass. Parent validation remains intentionally unchecked.

## Review Bugs Encountered

- **CRITICAL — `Sources/wm/DaemonHandler.swift:61-67`, `Sources/wm/DaemonLifecycle.swift:28-47`: startup/resume computes `WorkspaceIntentAudit.park` and `.restore`, but `auditCommittedIntent` ignores both collections. It restores only visible workspaces via a separate loop and tiles visible BSP workspaces; hidden workspaces that were left onscreen by an interrupted transition are never parked. Impact: readiness/resume can expose windows contrary to committed workspace intent, so crash recovery does not follow committed intent. Mitigation: execute one transactional audit plan: restore visible IDs, park every hidden ID while recording/retaining its committed restore frame, tile visible workspaces, verify all effects, and roll back/fail readiness or resume on any error. Add an integration test asserting a live hidden window is actually moved offscreen.

- **HIGH — `Sources/wm/WMMain.swift:63-79,86-93`, `Sources/wm/DaemonHandler.swift:191-193`: pause only gates request methods. The periodic and activation observers continue calling `reconcileObservedWindows` and `reconcileExternalFocus`, which mutate and persist workspace membership/focus and perform parking/restoration while paused. Impact: pause does not suspend mutations and committed intent can change behind the operator. Mitigation: put pause gating inside every mutation entry point (including observers), or make the observation loop collect inventory without lifecycle/focus reconciliation while paused; on resume run lifecycle reconciliation plus the full committed-intent audit before clearing pause. Add tests covering observer-driven membership and external-focus mutations during pause.

- **HIGH — `Sources/wm/WMMain.swift:66-70,109-112`: permission revocation calls `shutdown` from an observation callback and then `raise(SIGTERM)`, but restoration failure prevents the signal because of `try`, while final shutdown silently ignores restoration errors and still exits success. The server also remains accepting mutations during restoration. Impact: revocation may leave the daemon running without required permissions or may report clean shutdown while windows remain parked; concurrent requests can re-park/mutate windows during teardown. Mitigation: enter a terminating/paused state and stop accepting mutations first, attempt a best-effort restore of every window while collecting failures, always trigger shutdown in `defer`, and return/log a nonzero failure if restoration is incomplete. Add revocation and partial-restore-failure tests.

- **HIGH — `Sources/wm/WorkspaceController.swift:9-14`, `Sources/wm/WMMain.swift:39-55`: persisted-state load/validation errors and quarantined snapshots are silently converted to an empty workspace state, then startup reconciliation adopts live windows and declares readiness. Impact: corrupt, incompatible, or invalid committed intent is discarded, defeating config/state validation and causing recovery to follow newly synthesized intent rather than the last committed intent. Mitigation: make controller initialization throwing and distinguish absent from invalid/quarantined; fail readiness with a structured diagnostic for invalid committed state (or require an explicit recovery action) instead of silently resetting it. Test corrupt, incompatible-version, and validation-failure startup paths.

- **HIGH — `Sources/WMPersistence/DaemonProcessLock.swift:13-25`: the lock path is derived directly from attacker-influenced `XDG_STATE_HOME`; directory ownership/mode and file type/owner are not validated, and `open` follows symlinks. Existing lock files can therefore redirect the descriptor outside the state directory, and a shared/permissive XDG directory allows another local user to deny service or interfere with locking. Impact: local symlink/path attacks and unreliable per-user exclusivity. Mitigation: resolve only an absolute trusted per-user state directory; create/verify every directory is owned by the effective UID and not group/world writable; open the lock with `O_NOFOLLOW | O_CLOEXEC` (and preferably `openat` on a verified directory), then `fstat` for regular-file type, owner, and safe mode. Add symlink, relative-XDG, wrong-owner/mode, and inherited-FD tests.

- **MEDIUM — `Sources/wm/WMMain.swift:31-57`, `Sources/WMCLI/CLI.swift:117-132`: the process lock is acquired before daemon configuration is validated, and validation only checks that the port parses. Arbitrary/non-loopback hosts and malformed or unsafe origin values are accepted; no explicit policy requires an origin allowlist when externally bound. Impact: an invalid configuration can unnecessarily block a valid daemon during slow startup, and external binding can expose an unauthenticated window-control API. Mitigation: validate host/interface, port, and canonical `http(s)` origins before acquiring the lock; default/require loopback, or require explicit authentication plus nonempty scoped origins for non-loopback binds. Add parser/startup tests for invalid hosts/origins and external-bind policy.

- **MEDIUM — `Sources/wm/WMMain.swift:109-111`, `Sources/wm/DaemonHandler.swift:686-695`: graceful shutdown restores using the last cached inventory and skips committed parked windows absent from `sessionWindows`; it does not refresh inventory before restoration and does not retry/verify a complete set. Impact: windows temporarily omitted from the last scan remain parked after a nominally graceful exit. Mitigation: stop mutations, perform a fresh inventory scan, reconcile retained identities, restore all committed parked IDs with bounded retries, and surface any unresolved IDs as shutdown failure. Test an ID absent from the cached snapshot but present in the shutdown refresh.

- **MEDIUM — `Sources/wm/DaemonHandler.swift:255-263`: resume performs only inventory refresh and `auditCommittedIntent`; it does not run `ManagedWindowLifecycle.reconcile`, membership reconciliation, geometry cache reconciliation, or external-focus reconciliation before unpausing. Impact: windows opened/closed or management overrides changed during pause are not fully reconciled, violating full reconciliation on resume. Mitigation: share the normal refresh pipeline on resume (refresh, geometry/lifecycle reconciliation, committed-intent effect audit, focus reconciliation), and clear pause only after every step succeeds. Add pause/open-close/resume integration coverage.

- **MEDIUM — `Sources/wm/WMMain.swift:51-52`, `Sources/wm/DaemonHandler.swift:74-90`: readiness first calls `reconcileObservedWindows`, which persists adoption/removal changes, and only afterward audits the previously loaded intent. Impact: startup mutates committed state before proving it can repair effects; if audit fails, durable intent has already changed, so a subsequent restart no longer recovers strictly from the pre-start committed intent. Mitigation: load and validate committed state, construct/execute and verify the audit without committing observation-derived changes, then persist any lifecycle reconciliation only after successful audit (or use a single transactional desired/committed transition). Add an audit-failure test asserting the state file is unchanged.

- **LOW — `Tests/WMDaemonTests/DaemonLifecycleTests.swift:7-30`, `Tests/WMPersistenceTests/WorkspaceStateStoreTests.swift`: tests exercise only pure pause state, audit computation, and same-process lock exclusivity. They do not execute handler audit actions, request mutation coverage, observer pause behavior, revocation/shutdown failures, lock security/path behavior, readiness ordering, or crash recovery persistence. Impact: the acceptance criteria can appear green while core lifecycle guarantees are absent. Mitigation: add handler-level fakes for geometry/inventory/persistence, subprocess lock tests, and end-to-end lifecycle tests for each failure/order path above.

## Review Fix Plan

- [x] Execute and verify complete committed-intent effects before observation-derived persistence.
- [x] Centralize paused/terminating lifecycle gating and startup/resume/shutdown ordering.
- [x] Fail startup on invalid persisted state and unsafe daemon configuration.
- [x] Harden per-user lock path, directory, descriptor, type, ownership, and mode.
- [x] Add deterministic review-regression tests and run targeted validation.

## Review Resolutions

- Full audit now executes deterministic restore, park, and retile steps with AX readback verification; startup runs this before lifecycle reconciliation can persist observation-derived state.
- Observer membership and external-focus entry points enforce lifecycle state. Resume explicitly bypasses pause only inside its audit, lifecycle, and focus pipeline, and clears pause only after success.
- Permission revocation enters irreversible terminating/paused state before restoration, collects and reports per-window failures, and always signals termination. Graceful shutdown refreshes inventory and returns failure when any committed parked ID cannot be restored.
- Workspace controller initialization now throws on quarantined/corrupt/incompatible/invalid persisted state; readiness fails instead of synthesizing empty committed intent.
- Locking now rejects relative/unsafe paths, verifies owner/type/mode, refuses symlinks, and uses `O_NOFOLLOW | O_CLOEXEC`; relative XDG state homes safely fall back to the user state path.
- Daemon configuration is validated before lock acquisition, restricts unauthenticated binds to loopback, and accepts only canonical HTTP(S) origins without credentials, fragments, or paths.
- Added deterministic audit ordering/hidden parking plan, pause/termination, invalid-state initialization, lock symlink/mode/CLOEXEC/XDG, and unsafe bind/origin tests. Targeted daemon, persistence, and CLI suites pass; `swift build` and `git diff --check` pass. Full validation remains intentionally unchecked for parent validation.

## Parent Validation

- `swift test`: passed, 45 XCTest tests and 63 Swift Testing tests.
- `swift build`: passed.
- `git diff --check`: passed.

## Live Validation Blocker

- Started the production daemon with an isolated private `XDG_STATE_HOME` and port `17834`. Startup correctly failed closed with `inventory initialization failed: permissionDenied` because live health reports Screen Recording permission unavailable. Accessibility is available, but the new readiness policy requires both Accessibility and Core Graphics/Screen Recording capability.
- Because readiness was intentionally denied, live process-lock exclusivity and pause/resume requests could not be exercised. Grant Screen Recording permission to the built `wm` executable/session, then rerun live validation before completing and committing this bean.

## Live Validation

- Started production daemon on isolated port `17834` with private XDG state; real health reported Accessibility and Screen Recording available.
- `wm verify` passed welcome, request/response, subscription, refresh-event, and unsubscribe checks.
- A second daemon using the same state directory failed with `daemon lock failed: alreadyRunning`.
- `wm pause` set `paused: true`; ping remained available and reported paused state; `inventory refresh` returned structured retryable `paused`; workspace query remained available and observer activity did not mutate membership during the pause interval.
- `wm resume` returned `paused: false, reconciled: true`; ping and live inventory refresh succeeded afterward.
- SIGTERM stopped the daemon; the process exited and stderr remained empty, confirming graceful shutdown completed without unresolved restoration errors.

## Final Summary

Startup now fails closed without safe configuration, valid committed state, exclusive ownership, and required permissions. Readiness and resume repair live effects from committed workspace intent, pause blocks request and observer mutations, and permission revocation or graceful termination restore parked windows before exit.
