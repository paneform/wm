# Feature 06: Integration, Tests, And Examples

Owns package composition, daemon request router, executable wiring, live smoke
tests, TypeScript example, benchmark harness, and implementation-status docs.

Dependencies: all prototype slices.

Acceptance criteria:

- `swift build` and `swift test` pass.
- Daemon starts and reports ready or a structured permission error.
- CLI queries and direct WebSocket requests return identical result models.
- A TS example receives an initial projection and live refresh event.
- Benchmark records cold/warm CLI and WebSocket request timings.
