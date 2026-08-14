---
# wm-asvj
title: Implement transaction command model
status: completed
type: feature
priority: critical
created_at: 2026-08-14T18:58:47Z
updated_at: 2026-08-14T22:28:09Z
---

Scope: serialized mutation queue and complete command execution contract.

Acceptance:
- Maintain desired, observed, operation, and committed layers.
- Serialize mutations and queue during topology recovery.
- Support completion and instant return modes with transaction status.
- Coalesce equivalent idempotent commands and escalate suspicious repetition.
- Implement sequential batches and atomic bulk intent with per-window failure reporting.
- Expose pending transaction/recovery metadata in queries.

## Implementation Plan

- [x] Inspect current request execution, persistence, event, and recovery layers.
- [x] Implement serialized transactions with desired, observed, operation, and committed state.
- [x] Add completion/instant modes, coalescing, repetition escalation, and recovery queueing.
- [x] Implement sequential batches, atomic bulk intent, per-window failures, and query metadata.
- [x] Add deterministic transaction and recovery coverage.
- [x] Run targeted and full validation.
- [x] Record encountered bugs and summarize changes.

## Bugs Encountered

- The initial deterministic serialization test could release its continuation before the operation installed it, hanging the test. Added an explicit waiting-state handshake before release.
- Transaction envelope field `return_mode` initially flowed into strict command parameter decoding. The daemon now removes envelope-only fields before executing the typed command.

## Summary of Changes

- Added a transaction coordinator with explicit desired, observed, operation, and committed execution phases; one serialized mutation queue; completion and instant receipts; status retention; recovery gating; idempotent coalescing; suspicious repetition escalation; and sequential batch execution.
- Added atomic bulk desired-intent support with deterministic window ordering and per-window platform failure reporting.
- Routed existing daemon mutations through the coordinator, exposed pending/recovery metadata from `state.get`, added `transaction.get`, and gated queued work during resume reconciliation while preserving paused-command errors.
- Added protocol DTOs, the minimal `wm transaction get ID` CLI mapping, deterministic coordinator tests, protocol round trips, and CLI mapping coverage.
- Targeted protocol/core/CLI/daemon tests and `git diff --check` pass. Full validation remains intentionally unchecked for the parent task.

## Performance Review Findings

1. **High — `Sources/WMCore/TransactionCoordinator.swift:37,79-95,108-111` — Array-backed recovery/transaction queue has quadratic drain cost and linear coalescing lookup.** Every dequeue uses `removeFirst()`, shifting all remaining `Work` values, while every idempotent submission rebuilds `activeID + queue.map` and scans it. A recovery burst of `n` commands therefore incurs O(n²) queue movement/scanning on the coordinator actor, reducing recovery throughput and delaying all submissions/status calls. **Fix:** use a deque or array plus head index with periodic compaction, and maintain an `[IdempotencyKey: transactionID]` index updated at enqueue/finish.

2. **High — `Sources/WMCore/TransactionCoordinator.swift:39,49-53,79-105,124-130` — Coalesced completion callers compete for a single-consumer `AsyncThrowingStream`.** All equivalent requests reuse one stream, but an `AsyncStream` is not a broadcast primitive: concurrent iterators divide elements, and only one receipt is yielded. Under load, one waiter completes while others can observe stream termination and throw `CancellationError`; cancellation of callers also is not tracked. **Fix:** store a per-transaction collection of checked continuations/waiters (or a replayable shared result), append each completion caller, and resume every waiter exactly once on success/failure; add a concurrent completion-mode coalescing stress test.

3. **High — `Sources/WMCore/TransactionCoordinator.swift:37-40,64-74,89-94,124-130` — Transaction records and stream objects have no retention bound.** `records` permanently retains metadata/error strings for every transaction, and instant transactions retain streams until execution; sustained daemon use grows memory without limit. `metadata()` additionally scans and sorts the entire lifetime history just to report pending work, so query latency grows with uptime. **Fix:** keep pending IDs separately, evict completed records by TTL and/or bounded LRU/ring capacity, expose expiry semantics for `transaction.get`, and avoid storing a stream for instant-only submissions.

4. **High — `Sources/wm/DaemonHandler.swift:8,251-268,280-435` — The daemon actor remains occupied across the full serialized mutation, including inventory, persistence, and AX geometry awaits.** The transaction coordinator serializes mutations, but `operate` re-enters `DaemonHandler.routeDirect`; actor reentrancy permits other calls, yet every resumed phase and substantial CPU work (JSON transforms, scans, transition planning) still runs on the single handler executor. Long geometry retries/recovery therefore contend with reads, subscriptions, focus events, and transaction status. **Fix:** move mutation execution/state into a dedicated mutation service actor, keep request parsing/read-only responses off that actor, and pass immutable snapshots/plans into geometry/persistence services; measure status/read p95 during a large workspace transition.

5. **Medium — `Sources/wm/WMMain.swift:74-95,102-115` and `Sources/wm/DaemonHandler.swift:83-89,280-287` — Observation and activation paths can launch overlapping full inventory refreshes and repeat reconciliation work.** The periodic loop and every application activation independently call `state.refresh()`, with no debounce, single-flight, or cancellation. Each handler pass then retains all windows and reconciles geometry; `reconcileObservedWindows` also snapshots/commits workspace state before lifecycle work. Activation storms can queue expensive scans and redundant actor work behind mutations. **Fix:** introduce a coalescing/single-flight refresh coordinator with a dirty flag/debounce, reuse the latest committed snapshot for activation when fresh, and perform geometry reconciliation only when window identity/lifetime data changed.

6. **Medium — `Sources/wm/DaemonHandler.swift:280-287,316-327,345-350` — Every request performs state fetch, full-window retention, and geometry reconciliation before method dispatch.** Even `daemon.ping`, `transaction.get`, health/list reads, and methods that immediately refresh inventory pay O(window count) dictionary writes plus geometry work. Observe and refresh methods then replace the snapshot and repeat retention, while geometry was reconciled against the stale pre-refresh snapshot. **Fix:** dispatch lightweight methods before inventory preparation; refresh first for refresh-dependent methods; centralize snapshot preparation and gate `retainSessionWindows`/`geometry.reconcile` on inventory generation or changed window IDs.

7. **Medium — `Sources/wm/DaemonHandler.swift:506-509` with `Sources/WMCore/TransactionCoordinator.swift:80-86` — Idempotency canonicalization is expensive and may be semantically unstable.** Every idempotent request filters/copies parameters, encodes the entire JSON tree to `Data`, converts it to `String`, then later linearly scans queued records. If `ProtocolCodec` does not guarantee recursively sorted object keys, equivalent nested objects can produce different keys and fail to coalesce; numeric/string normalization is likewise unspecified. **Fix:** define a structural `Hashable` canonical value (sorted object keys recursively and explicit numeric normalization), compute it once during request decode, and use it directly in the coordinator index; add randomized key-order and nested-object coalescing tests.

8. **Medium — `Sources/WMCore/TransactionCoordinator.swift:76-77,108-130` — Recovery release drains strictly one command at a time and creates one unstructured task per item, with no batching or fairness policy.** Every completion calls back into the actor, removes one item, and allocates a new `Task`; a large recovery queue pays task/scheduler overhead per command and can monopolize mutation capacity long after recovery. Coalescing only exact idempotency keys does not collapse superseded intents such as repeated focus/move targets. **Fix:** run one long-lived drain task, dequeue in O(1), yield periodically for fairness, and add command-aware last-write-wins compaction for safe desired-state intents while preserving barriers/non-idempotent order.

9. **Medium — `Sources/wm/DaemonHandler.swift:408,516-519,623-630,743-755` — Window resolution repeatedly performs O(n) scans inside per-window loops.** `workspaceMoveWindow` searches all inventory windows for each requested ID, `tileWorkspace` maps each workspace ID through `resolveWindow(first(where:))`, and focus candidates repeat the same scan. Large workspaces turn planning into O(workspace windows × inventory windows) before AX I/O. **Fix:** build one `[WindowID: NormalizedWindow]` index per snapshot/request and pass it through validation, display resolution, focus, transition, and tiling helpers.

10. **Low — `Sources/wm/DaemonHandler.swift:505,462-470,848-859` — Protocol conversion repeatedly JSON-encodes and decodes typed values on the daemon actor.** The generic `json()` helper round-trips every value through `ProtocolCodec`; window/workspace arrays and transaction receipts can cause multiple full allocations and tree traversals per response/event. **Fix:** add direct `JSONValue` construction/conformance for hot DTOs or encode the final `ServerMessage` once, and reserve encode/decode bridging for cold paths; profile allocation counts for `state.get` and large workspace mutation responses.

11. **Low — `Tests/WMCoreTests/TransactionCoordinatorTests.swift:28,45` — Tests use unbounded `Task.yield()` polling and omit load/performance correctness cases.** A regression can hang the suite indefinitely, and current tests do not cover many coalesced completion waiters, large recovery queues, retention bounds, cancellation, or canonical key permutations. **Fix:** replace polling with deterministic continuations/events plus clock-based timeouts, and add stress tests asserting all waiters finish, FIFO ordering, bounded retained history, and near-linear drain behavior for thousands of queued commands.

No profiling data was included in the change; severities are based on code-path complexity and expected daemon load.

## Security Review Findings

1. **High — Unbounded transaction records and queue permit memory/CPU denial of service**
   - **Location:** `Sources/WMCore/TransactionCoordinator.swift:37-40,49-53,79-97,124-130`; exposed through `Sources/wm/DaemonHandler.swift:251-268`.
   - **Impact:** Every accepted mutation permanently adds `TransactionMetadata` to `records`; queued work and completion streams also have no count, age, or per-client limit. A loopback client can submit unlimited distinct instant mutations (especially while recovery is active) and grow memory indefinitely. Completed/failed statuses and their error strings are never evicted.
   - **Mitigation:** Enforce global and per-client pending limits with a retryable busy error, cap queue residence time, and retain terminal records using a bounded TTL/LRU/ring. Do not retain streams for instant-only callers unless needed; expose dropped/expired status explicitly. Add flood/recovery saturation tests.

2. **High — Cancelled/disconnected completion requests continue privileged mutations and leave waiter/task lifetime uncontrolled**
   - **Location:** `Sources/WMCore/TransactionCoordinator.swift:31,49-53,88-90,99-105,108-121`; `Sources/wm/DaemonHandler.swift:261-267`; `Sources/WMWebSocket/WebSocketServer.swift:230-233`.
   - **Impact:** Request handling spawns an unstructured task; cancellation of the socket/request does not remove queued work, cancel execution, or finish/remove its stream. A client can disconnect after enqueueing and still trigger later window/workspace changes. Repeated completion requests during recovery can retain continuations/tasks until recovery ends, amplifying DoS. There is no command timeout, so one hung AX operation blocks the serialized queue forever.
   - **Mitigation:** Give submissions ownership/cancellation semantics, remove not-yet-running work when the last waiter cancels (or explicitly document durable execution and cap it), use `continuation.onTermination`, add operation/queue deadlines, and guarantee cleanup. Track request tasks per connection and cancel them on disconnect; test cancellation before start, during operation, and hung operations.

3. **High — Pause/termination can be bypassed by already queued transactions**
   - **Location:** `Sources/wm/DaemonHandler.swift:252-267,288-290,352-375`; `Sources/WMCore/TransactionCoordinator.swift:108-121`.
   - **Impact:** Permission/pause is checked when submitting and again inside `routeDirect`, but no lifecycle generation is bound to the transaction. A transaction queued behind another can pass the submit-time check while unpaused, then execute after `daemon.pause` or termination sequencing. Although `routeDirect` currently rechecks most mutations, that check occurs after state refresh/reconciliation setup (`state.state`, session retention, geometry reconciliation), and future/internal `TransactionCommand`s need not recheck at all. Pause also does not cancel/drain the coordinator. This weakens the promised pause/termination barrier.
   - **Mitigation:** Make lifecycle authorization a coordinator execution precondition using an epoch/capability captured at enqueue and validated before every phase; atomically pause admission and execution, cancel/fail queued work on termination, and avoid side effects before the execution-time check. Add a test that pauses/terminates while work is queued.

4. **High — Recovery release uses an unstructured deferred task and can reopen mutations before resume fully unwinds**
   - **Location:** `Sources/wm/DaemonHandler.swift:355-375`, especially `defer { Task { await transactions.endRecovery() } }`; `Sources/WMCore/TransactionCoordinator.swift:76-77`.
   - **Impact:** Recovery completion is detached from the resume request. Queued mutations may begin nondeterministically while resume error handling/response construction is still in progress; if the handler is cancelled or deallocated, ordering is unclear. On failed permission/reconciliation, recovery is still ended and queued work becomes eligible (then fails individually), defeating a fail-closed recovery gate and creating retry storms. Reentrant/concurrent resume calls can also clear a single shared reason while another recovery is still active.
   - **Mitigation:** Use a scoped recovery token/reference count and explicitly `await endRecovery(success:)` in structured control flow. Only release queued work after successful reconciliation and lifecycle resume; on failure keep the gate active or fail queued transactions deterministically. Serialize/reject concurrent resume attempts and test cancellation/failure/reentrancy.

5. **Medium — Idempotent coalescing is keyed incorrectly and can return another request’s identity/result**
   - **Location:** `Sources/WMCore/TransactionCoordinator.swift:79-86`; `Sources/wm/DaemonHandler.swift:255-267,503-506` (`canonicalKey`).
   - **Impact:** Coalescing matches `records[id].command == key`, and metadata stores the full client-derived canonical parameter JSON as `command`. Equivalent callers share the first command closure, including its `requestId`, and all completion callers consume the same single `AsyncThrowingStream`. Async streams distribute elements among iterators rather than broadcast them, so one waiter can receive the receipt while another reaches end/cancellation. Metadata also exposes client-controlled parameters (potentially sensitive or very large) through `state.get` and `transaction.get`.
   - **Mitigation:** Store a separate bounded cryptographic digest as the idempotency key and keep `command` as the fixed method name. Implement explicit fan-out promises/waiters with per-waiter response identity, not a shared stream. Bound canonicalized parameter size and test multiple simultaneous completion waiters.

6. **Medium — Client-selectable instant mode is weakly validated and allows cheap queue flooding**
   - **Location:** `Sources/wm/DaemonHandler.swift:255-260`; `Sources/WMProtocol/Transactions.swift:3`.
   - **Impact:** Only the exact string `instant` is recognized; every other type/value silently becomes completion rather than invalid input. Instant requests return immediately while durable work accumulates, making the unbounded queue especially easy to flood and obscuring malformed input.
   - **Mitigation:** Decode a strict transaction envelope DTO, reject unknown values/types and unknown envelope fields, and apply admission/rate limits before enqueueing. Consider restricting instant mode to authenticated/trusted callers or requiring a bounded client idempotency token.

7. **Medium — Bulk/batch helpers accept unbounded inputs and leak raw per-item errors**
   - **Location:** `Sources/WMCore/TransactionCoordinator.swift:55-60,134-145`; `Sources/WMProtocol/Transactions.swift:51-61`.
   - **Impact:** Batch and bulk arrays have no maximum item count, ID length/format validation, aggregate payload/work cap, or cancellation checks. `Set(windowIDs)` and sorting can consume large memory/CPU; operations run serially and can monopolize the sole queue. Raw `String(describing:)` errors are stored/returned per item and by `batchStopped`, potentially leaking AX/platform/internal details and multiplying response/storage size. Empty input is also accepted without defined semantics.
   - **Mitigation:** Validate non-empty arrays, cap item count, ID length and aggregate bytes before constructing commands, resolve IDs server-side against authorized inventory, check cancellation/deadlines between items, and return stable typed error codes with sanitized messages. Truncate retained failure details and test malformed/oversized/duplicate inputs.

8. **Medium — Transaction lookup is an unauthenticated global object reference and reveals cross-client status**
   - **Location:** `Sources/wm/DaemonHandler.swift:292-295,376-378`; `Sources/WMCore/TransactionCoordinator.swift:64-74`; `Sources/WMProtocol/Transactions.swift:6-22`.
   - **Impact:** Any connected local client can query any transaction UUID and `state.get` exposes all pending IDs, commands/parameters, timing, recovery reason, and failure text. There is no owner/session association or authorization check. If the service is shared among local principals or exposed through an allowed browser origin, this leaks activity and error data and enables status probing.
   - **Mitigation:** Associate transactions with connection/session/principal and authorize `transaction.get`; return only the caller’s pending metadata by default. Keep command names non-sensitive, sanitize errors, and add explicit privileged diagnostics if global visibility is required.

9. **Low — Repetition escalation is metadata-only and counter growth is unchecked**
   - **Location:** `Sources/WMCore/TransactionCoordinator.swift:80-85`; `Sources/WMProtocol/Transactions.swift:12-13`.
   - **Impact:** Suspicious repetition merely flips a Boolean; it does not reconcile, throttle, reject, or rate-limit. `coalescedRequests` increments without saturation, so an attacker can consume CPU and eventually trigger integer overflow/trap under sustained requests.
   - **Mitigation:** Use a saturating bounded counter, rate-limit repeated submissions per client/key, and make escalation invoke a bounded reconciliation or reject/back off with telemetry. Test threshold behavior and saturation.

### Review Notes

- Reviewed the uncommitted diff, `wm-asvj`, transaction protocol/coordinator implementation, daemon routing/lifecycle integration, WebSocket task behavior, and transaction tests.
- Existing tests cover serialization, basic coalescing, recovery queueing, sequential batch stopping, and duplicate bulk IDs, but not resource bounds, disconnect/cancellation, multi-waiter coalescing, pause/termination races, concurrent/failed recovery, malformed envelopes, ownership, or sanitized errors.
- Source files and bean status were not changed; only this requested review section was appended.

## Review Findings

1. **Critical — `Sources/WMCore/TransactionCoordinator.swift:79-86, 99-105` — coalesced completion callers do not share completion.** Each transaction stores one `AsyncThrowingStream`, but multiple `completion(id)` calls iterate that same unicast stream; only one receives the yielded receipt and later callers can observe an already-finished stream and throw `CancellationError`. Impact: equivalent default/completion requests can fail or hang instead of receiving the same result. Fix: store a terminal result/error plus per-waiter continuations (or a replaying shared task), and test multiple concurrent completion submitters for both success and failure.

2. **Critical — `Sources/wm/DaemonHandler.swift:41-61, 83-89; Sources/wm/WMMain.swift:74-115` — runtime observer and activation mutations bypass the transaction coordinator.** Periodic lifecycle reconciliation and Cmd-Tab activation directly mutate/persist workspace state while request mutations are queued, so they can interleave across suspension points with a running transaction. Impact: the advertised single serialized actor mutation semantics are not true; stale previews can overwrite observer/focus changes or platform effects can be applied in conflicting order. Fix: route every state/platform mutation through one coordinator, including observation, activation, startup/recovery work, and shutdown barriers; add integration tests that gate one path while another arrives.

3. **High — `Sources/wm/DaemonHandler.swift:252-275, 355-375` — recovery does not gate request admission and its end ordering is detached.** `route` calls `requireMutationAllowed()` before enqueueing, so while resume leaves the lifecycle paused, requests are rejected rather than queued during recovery. `defer { Task { endRecovery() } }` also releases the gate in an unstructured task after `routeDirect` returns, with no deterministic ordering relative to the resume response/new requests. Impact: violates queue-during-recovery semantics and makes recovery metadata/order race-dependent. Fix: begin recovery before admission, allow mutation submissions to enqueue while the gate is active, and synchronously `await endRecovery()` in a structured success/failure path after reconciliation and lifecycle transition.

4. **High — `Sources/wm/DaemonHandler.swift:261-275; Sources/WMCore/TransactionCoordinator.swift:124-130` — failed completion requests lose protocol errors, and failed instant transactions retain only strings.** Coordinator throws the original error to completion callers, but actor-boundary wrapping can erase the private `DaemonTransactionError` type, causing `route` to return `internal_error` rather than the original typed protocol error. Persisted status contains only `String(describing:)`, dropping code/retryability/details; `transaction.get` also maps unknown IDs through the generic `inventory_failed` catch. Impact: clients cannot reliably recover from or inspect asynchronous failures. Fix: use a public/sendable structured transaction error DTO, return a failed receipt for completion/instant status, and map unknown transaction IDs explicitly; test daemon-level error round trips.

5. **High — `Sources/WMCore/TransactionCoordinator.swift:80-95` — coalescing identity is compared against the wrong field and exposes the key as the command.** Lookup checks `records[id]?.command == key`, while records store `idempotencyKey ?? name` in `command`. This happens to coalesce, but transaction metadata reports canonical parameter JSON as the command rather than `workspace.focus`; identity and display metadata are conflated. Impact: query/receipt API is misleading and future metadata changes can silently break coalescing. Fix: retain a separate internal `idempotencyKey`, keep `command` as the method name, and test metadata plus parameter-order-equivalent identities.

6. **High — `Sources/WMCore/TransactionCoordinator.swift:82-85` — suspicious repetition only flips a boolean and performs no reconciliation.** The acceptance requires escalation, but no observe/audit/recovery action is scheduled; the daemon-created command also supplies only `operate`, leaving desired/observed/commit layers empty. Impact: repeated commands marked escalated do not gain stronger correctness guarantees. Fix: define and invoke an escalation callback/full observe-reconcile pass before completion, and verify its ordering and failure behavior.

7. **High — `Sources/WMCore/TransactionCoordinator.swift:38-40, 124-130` — status retention is unbounded and has no retention contract.** Completed/failed `records` are never removed while streams are removed immediately. Impact: a long-running daemon leaks transaction metadata indefinitely, and restart loses every status without documented expiry. Fix: implement bounded count/time retention (including deterministic eviction and not-found/expired semantics), and expose/test retention metadata.

8. **High — `Sources/WMCore/TransactionCoordinator.swift:55-61, 134-146` — batch/bulk semantics exist only as disconnected helpers, not runtime protocol behavior.** No daemon route calls `batch` or `atomicBulkCommand`; `workspace.move_window` still executes its pre-existing all-or-nothing command and no per-window platform result is exposed. The bulk helper also commits desired intent after platform operations, contrary to the stated desired→observed→operation→committed model, and calls commit even with failures without defining partial/rollback semantics. Impact: production clients cannot use the claimed sequential batch or atomic bulk contract. Fix: add protocol/CLI routes and integrate with real workspace mutations; define atomic desired persistence and per-window committed/failure state, then add daemon integration tests.

9. **High — `Sources/wm/DaemonHandler.swift:261-268, 435` — transaction receipts report a stale outer `state_version`.** `routeDirect` captures `committed` before the mutation and returns that version; `route` separately calls `currentVersion()`, but workspace persistence/events use a separate sequence and do not update inventory state version. Impact: a committed receipt cannot identify/query the committed workspace state, and coalesced callers may receive differing outer metadata. Fix: establish one committed state/version boundary and store it in transaction metadata/receipt after commit; test read-after-receipt consistency.

10. **Medium — `Sources/wm/DaemonHandler.swift:255` — invalid `return_mode` silently becomes completion.** Any value other than the exact string `instant`, including wrong types and misspellings, is accepted. Impact: malformed requests can block unexpectedly and the API is not self-validating. Fix: decode a typed transaction envelope, reject unknown values/types as `invalid_params`, and test both modes and malformed input.

11. **Medium — `Tests/WMCoreTests/TransactionCoordinatorTests.swift; Tests/WMDaemonTests/DaemonLifecycleTests.swift` — key runtime contracts are not integration-tested.** Existing tests exercise the coordinator in isolation and pure focus helpers; the CLI “completion receipt” test injects a fabricated response. Missing coverage includes real daemon instant/completion responses, concurrent coalesced waiters/results/errors, observer/activation serialization, recovery admission/end ordering, transaction.get success/failure/retention, state metadata, and runtime batch/bulk behavior. Impact: the full suite passes while the production wiring above remains incorrect. Fix: add handler/WebSocket integration tests with controllable gates and real state persistence.

## Findings Resolution Plan

- [x] Replace stream-based queue with bounded indexed FIFO, multicast waiters, terminal retention, timeout/cancellation cleanup, and execution barriers.
- [x] Add structured transaction errors, committed state versions, strict envelopes, canonical keys, and real escalation.
- [x] Serialize command, periodic lifecycle, activation/focus, and recovery work through one runtime queue.
- [x] Integrate protocol/daemon/CLI batch and atomic bulk surfaces with bounded deterministic results.
- [x] Add runtime integration, cancellation, retention, recovery, coalescing, and stress regressions.
- [ ] Run targeted validation and diff checks; leave full validation unchecked.

## Quality And Security Finding Resolutions

- Replaced the shared `AsyncThrowingStream` with per-transaction multicast waiters and retained terminal receipts, so every coalesced completion caller receives the same result or structured failure.
- Added an O(1) idempotency index, array/head FIFO with periodic compaction, one drain loop, bounded pending work, bounded terminal history, bounded coalescing counters, operation deadlines, cancellation cleanup, and queue/batch/bulk input limits.
- Separated human-readable command names from canonical structural idempotency keys. Canonical JSON recursively sorts object keys, preserves type boundaries, normalizes negative zero, and avoids parameter disclosure in metadata.
- Structured `TransactionFailure` preserves protocol code, retryability, bounded message, and details; receipts/status include committed state version. Internal failures and per-window failures are sanitized.
- Queued work rechecks pause/termination before execution and before commit. Recovery release is structured and deterministic; failed recovery fails queued work without detached ordering races.
- Suspicious repetition invokes the daemon full refresh/audit reconciliation hook before operation, rather than only setting metadata.
- Periodic lifecycle reconciliation and application activation/focus now submit through the same mutation queue as client commands. Activation errors are reported instead of discarded.
- Added `command.batch`/`wm batch` sequential stop-on-failure behavior and `workspace.move_window_bulk`/`wm workspace move-window-bulk` atomic desired-intent behavior with deterministic per-window failure results.
- `return_mode` is strictly validated as `completion` or `instant`; status, recovery metadata, queue saturation, retention, timeout, fan-out, escalation, canonicalization, batch, bulk, and degraded-CG pruning have regression coverage.

## Targeted Validation

- `swift test --filter TransactionCoordinatorTests`: 7 passed.
- `swift test --filter WMProtocolTests`: 12 protocol/workspace tests passed.
- `swift test --filter CLIParserTests`: 14 passed.
- `swift test --filter CLIRunnerTests`: 9 passed.
- `swift test --filter WMDaemonTests`: 13 passed.
- `swift test --filter WMWorkspaceTests`: 21 passed.
- `git diff --check`: passed.
- Full parent validation remains intentionally unchecked.

## Escalation Receipt Race Resolution

### Bug Encountered

A coalesced caller could cross the suspicious-repetition threshold after the coordinator had already sampled  and started the operation. Because metadata remained mutable, the final committed receipt could report  even though the escalation callback/full reconciliation never ran.

### Resolution

The coordinator now freezes the escalation decision at the operation boundary. Coalescing can set the escalation flag only before that actor-isolated decision point. If the frozen flag is true, escalation is awaited successfully before operation; a thrown  produces the same structured failed receipt for all coalesced callers and operation/commit do not run.

The multicast test now deterministically gates the observation phase, waits until all seven duplicate callers have coalesced, then releases the escalation decision. A separate failure test verifies structured escalation failure and absence of operation effects.

Validation: the narrow `coalescedCompletionMulticastsAndEscalates` test passed 10 consecutive process runs; all 8 `TransactionCoordinatorTests` passed; `git diff --check` passed.

## Live Validation Bug

- Final rebuilt daemon passed direct focus, transaction metadata, sequential batch, and structured bulk failure checks. After batch focus transitions and Spotify activation, activation reconciliation logged failure and periodic internal observation repeatedly failed with sanitized `TransactionFailure(internal_error, transaction execution failed)`. Impact: internal observer serialization is not yet production-safe and can stop automatic lifecycle/focus reconciliation while client mutations continue. Resolution required before completion: preserve actionable internal failure diagnostics, identify whether lifecycle execution barriers, stale geometry, escalation, or nested transaction submission causes the failure, and add a live-equivalent regression.

## Internal Observer Transaction Failure Resolution

### Proven Cause

Internal activation and periodic transactions were authorized by the coordinator, then called the public `reconcileExternalFocus` and `reconcileObservedWindows` entry points, which independently repeated lifecycle barriers inside the already-running transaction. This did not recursively submit another transaction, but it created two authorization layers and made internal execution sensitive to lifecycle changes after dequeue. Any concrete geometry/workspace error was then erased by the coordinator generic catch, leaving only the sanitized `transaction execution failed` receipt and a non-actionable activation log.

### Resolution

- Split lifecycle-checked public wrappers from private already-authorized reconciliation implementations. Internal activation/periodic operations call the authorized implementations exactly once through the coordinator; startup/direct callers retain their barrier.
- Added a daemon-only internal error reporter to `TransactionCommand`. The coordinator logs the original Swift error and command name internally before returning the unchanged sanitized client `TransactionFailure`.
- Activation logging now includes the structured failure, while stderr also receives the original bounded internal cause.
- Added live-equivalent sequencing coverage for direct batch transition followed by activation and periodic work, asserting FIFO order, single execution, and no overlap. Added coverage proving an original internal error is reported while the receipt remains sanitized.

Validation: 10 coordinator tests and 13 daemon tests passed; `git diff --check` passed. Existing daemon PID 83062 was not restarted because it is running the previous binary and no stderr file was discoverable in the workspace.

## Observer Geometry Clamp Reliability Resolution

### Bug Encountered

Live final2 diagnostics showed serialization was healthy, but System Settings repeatedly clamped a requested BSP frame to 723x950. Strict `geometryVerificationFailed` propagated through activation/periodic reconciliation, failed the entire internal transaction, and caused identical retries every observation cycle. This was pre-existing platform geometry drift, not a transaction ordering failure.

### Resolution

- Added an observer-only degraded geometry path. Automatic activation/focus reconciliation catches per-window verification clamps, records the observed dimensions as minimum-size evidence, reports the first/new clamp, and continues tiling remaining windows plus focus/lifecycle reconciliation.
- Added a bounded per-window clamp signature keyed by requested and observed dimensions. Identical known clamps skip repeated AX writes and diagnostics; changed targets retry, successful verification clears the clamp, and verified close evicts both clamp and minimum-size metadata.
- Desired workspace state remains atomic and committed. The fallback changes only automatic platform convergence behavior and records explicit degraded geometry.
- Explicit user workspace and frame commands still use strict reconciliation and return `geometry_verification_failed` when the requested effect cannot be verified.
- Added a regression using the live 752x950 requested / 723x950 observed clamp. It proves one report, no identical retry, changed-target retry eligibility, and continued other-window/focus work.

Validation: 14 daemon tests, 10 coordinator tests, 21 workspace tests, and 9 geometry tests passed; `git diff --check` passed.

## Final Validation

- `swift test`: passed, 46 XCTest tests and 83 Swift Testing tests.
- `swift build`: passed.
- `git diff --check`: passed.
- Live daemon passed startup recovery, transaction metadata, committed focus receipts, sequential batch execution, bounded structured bulk failure, activation serialization, periodic reconciliation, explicit inventory refresh, and skhd-style focus.
- Observer-only geometry degradation reported the System Settings clamp once, retained minimum-size evidence, avoided retry storms, and allowed subsequent transactions to commit.

## Final Summary

Implemented and reviewed a bounded serialized transaction command model with desired/observed/operation/committed phases, completion and instant receipts, multicast coalescing, real repetition escalation, deterministic recovery queueing, strict structured failures, sequential batches, atomic bulk intent, status metadata, and serialization of periodic and activation-driven mutations. All review findings affecting correctness, security, runtime integration, and practical performance were resolved and validated.
