# Adaptive Diagnostics

Diagnostics are named, versioned procedures that produce durable typed facts about behavior the
window manager cannot safely infer from API declarations alone. Examples include WindowServer
parking constraints and application-window geometry capabilities.

## Fact Model

Every result is a `ResolvedDiagnostic<Value>`. It carries the value and immutable provenance:
the diagnostic identifier and algorithm revision, an environment fingerprint, a generation, and
the measurement time. Consumers retain that provenance rather than receiving an unlabelled value.

The fingerprint declares the conditions under which the result is valid. Parking facts are scoped to
one display and include its ID, the OS version, and normalized display topology. Window-capability diagnostics can instead use application,
role, subrole, and window-lifetime scopes. Changing the procedure requires incrementing its revision.

`DiagnosticCoordinator` loads matching facts, single-flights missing work, persists successful
results, and invalidates by generation. Generation-aware invalidation prevents an old operation from
deleting a newer result.

## Procedure Lifecycle

1. A capability demand checks for a matching durable result without delaying its foreground action.
2. Missing facts coalesce into one cancellable background task.
3. The task leases an otherwise-hidden pending subject, samples behavior, restores it, and only then
   publishes its result.
4. Consumers retain provenance and verify each use against the diagnosed rule.
5. A verification failure invalidates the exact consumed generation and queues another background
   run; it does not fail the already-committed focus operation.

Parking has no startup procedure. Workspace intent, reveal, layout, and focus commit first. Outgoing
hidden windows become pending work until cached limits can be used or a safe probe can be leased.
Procedures revalidate identity, lifetime, authoritative visibility, and environment generation before
every mutation.

### Workspace Authority

Layout and reveal authority belongs only to the frontmost workspace assigned to each display. Parking
authority belongs to every other workspace assigned to that display. Reconciliation must therefore
ignore geometry drift for inactive workspace windows; it must not lay them out, restore them, or cancel
a diagnostic because an inactive window moved.

When focus moves from workspace A to workspace B, B is committed, revealed, laid out, and focused
first. An authoritative parking audit then attempts to park A. If parking values are unavailable, that
parking attempt exits and dispatches the single-flight parking diagnostic. No layout or reconciliation
is applied to A while it remains inactive. The diagnostic may probe a position-capable A window,
restore it, and durably publish the result. Publication schedules a new authoritative parking audit,
which scans every display and parks every workspace that is not frontmost on its assigned display.

The inactive-workspace invariant removes the need for probe-specific observer suppression, floating,
unmanagement, or a separate management-suspension state. If the probe workspace becomes frontmost,
the diagnostic restores the probe and stops; the newly visible workspace regains normal layout and
reveal authority.

## Parking Limits

Parking records the minimum horizontal and vertical visible extents accepted at each exposed display
corner. Values are nonnegative relative extents, including zero, so they apply to windows of different
sizes. Probing is position-only and never requests or depends on resize capability. For each axis the
procedure first verifies a fully visible corner anchor, then requests the zero-visible external endpoint.
Each axis retained exactly is complete at zero visibility. For each clamped axis, the observed clamp is
the new accepted bound; the requested endpoint is rejected and is excluded by one integer point toward
that bound. Fractional clamps round toward the fully-visible side. The procedure independently searches
only that clamp-seeded interval toward the endpoint, holding an endpoint-retained orthogonal axis at its
endpoint and a not-yet-refined clamped orthogonal axis at its observed clamp. It reconfirms the accepted
searched-axis point before converting the fixed-size coordinates to nonnegative visibility. Search
acceptance compares only the searched coordinate; an orthogonal clamp is expected coupling evidence and
does not reject an otherwise retained searched coordinate. A known rejected bound avoids a redundant
adjacent rejection request.

An available parking plan has exactly one visibility exception: the assigned display may retain the
diagnosed unavoidable horizontal and vertical sliver. The plan's actual fixed-size target must have zero
area of intersection with every other attached display; touching a display edge is not intersection.
This is evaluated per window because its dimensions and the diagnosed corner limits determine the final
rectangle. Consequently, a partially aligned neighbor can block one corner while leaving another valid:
for example, a display extending far enough below its right-hand neighbor may use its bottom-right corner
when the diagnosed target clears that neighbor, but not when even a one-point strip still overlaps it.
Observed placement is checked against both the assigned-display limits and all neighboring display
frames. A clamp into a neighbor invalidates the consumed diagnostic provenance.

Diagnostics prefer an already parked hidden managed window when its workspace retains a visible restore
frame. Display assignment comes from authoritative workspace state, not the probe's current center. The
current fixed-size frame and the restore frame remain distinct: each current coordinate may seed its axis
when it is on the selected corner's anchor-to-endpoint interval and the resulting frame is topology-safe.
An unusable coordinate falls back to the visible corner anchor. A hidden probe returns to its retained
current frame before publication and is then included in the full authoritative parking audit; a probe
whose workspace became visible returns to its saved visible restore frame.

The zero-visible endpoint request produces independent X and Y evidence. An axis retained exactly at its
endpoint is complete with zero visibility. A clamped axis rounds fractional observed evidence toward the
visible side, combines it with any closer retained parked seed, and then searches with shared probes: every
probe requests one combined frame reflecting both axes' current best coordinates, and each response updates
each axis independently, so a clamp on one axis never fails the other. Each searched axis first probes
exactly one point past its clamp seed, then binary-searches the inclusive remaining interval — including its
upper bound — until the maximally off-screen retained coordinate is known. After all axes converge, the
winning combined frame is re-probed once and must be jointly retained; coupled platform behavior that
prevents joint retention is reported inconclusive rather than persisted. Every request remains
position-only, preserves the fixed dimensions, and is rejected if its requested or observed frame
intersects another display.

Before mutating a probe, diagnostics reject a corner whose fixed-size swept region from its usable seeded
start (or visible anchor fallback) to the zero-visible endpoint intersects another display. Individual
corner failures continue to other topology-safe corners, and candidate failures continue through every
hidden managed position-capable window, so deterministic ordering cannot starve calibration. A display
with no safely diagnosable corner remains pending and emits a bounded deferred diagnostic; it is never
parked on another monitor.

If another hidden window clamps outside a published limit, invalidation records that concrete window as
the next preferred probe and reschedules only after the current audit exits. This monotonically widens a
display fact to the strictest observed application constraint instead of repeatedly selecting an easier
parked probe.

Each display has an independent durable fact. Pending windows trigger calibration only for their owning
display, so evidence from one display is never treated as complete for another.

The live probe holds a revocable lease. A focus targeting that window cancels its sample and waits only
for verified restoration, not for calibration; diagnosis can migrate to another still-hidden pending
window. Session and topology generations cancel the lease, restore the probe, and discard stale
evidence. Each sample validates the requested position, unchanged size, fixed orthogonal coordinate,
identity, lifetime, and generation. Orthogonal coupling or size drift makes the diagnosis inconclusive;
ordinary position clamping does not. Restoration is position-only and verified, with a safe in-bounds
anchor before a final retry when direct restoration clamps. Runtime
parking plans carry provenance and invalidate the exact fact when observed placement violates it.

## Storage

`WMPersistence.DiagnosticStore` stores a versioned catalog at `diagnostics.json` using synchronized
temporary writes and atomic rename. Diagnostic facts are separate from workspace intent and learned
window profiles so corrupt or obsolete environmental evidence cannot invalidate authoritative state.
Corrupt, oversized, or unsupported catalogs are cache misses rather than startup failures. Catalog and
payload counts are bounded, and topology fingerprints are compact deterministic digests that omit raw
display names and serial numbers.
