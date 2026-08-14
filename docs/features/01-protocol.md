# Feature 01: Protocol And Domain Contracts

Owns shared `Codable` message envelopes, errors, IDs, inventory/state DTOs,
event topics/projections, JSON codec behavior, and contract tests.

Dependencies: none.

Does not own transport, CLI parsing, or macOS APIs.

Acceptance criteria:

- Models match `docs/api.md` exactly.
- Deterministic snake_case JSON.
- Unknown enum values and malformed variants fail with structured errors.
- Round-trip tests cover every message and state model.
