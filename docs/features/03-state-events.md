# Feature 03: State, Diffing, And Events

Owns immutable committed inventory snapshots, state versions, event sequences,
typed window/display deltas, health transitions, bounded replay, subscription
projections, and backpressure-independent event fanout.

Dependencies: protocol/domain contracts and inventory output.

Does not own network socket writes.

Acceptance criteria:

- Refreshes serialize and equivalent concurrent requests coalesce.
- Queries read the last committed immutable snapshot.
- Added/updated/removed diffs are deterministic.
- Sequence/state versions are monotonic.
- Replay and resync behavior matches `docs/api.md`.
- Subscriber queues cannot block refresh/commit.
