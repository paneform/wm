# Feature 05: Single-Binary CLI Frontend

Owns one `wm` executable, daemon/client dispatch, argument parsing, WebSocket
client, JSON output, NDJSON subscription output, aliases, exit codes, and local
lifecycle placeholders.

Dependencies: protocol contracts and WebSocket transport.

Does not duplicate request handling or inventory logic.

Acceptance criteria:

- CLI mappings match `docs/api.md`.
- Every ordinary command uses the same WebSocket methods as direct clients.
- Stdout is JSON/NDJSON only; diagnostics/help use stderr where appropriate.
- `monitor list` aliases `display list` only at CLI layer.
- Client-only invocations do not initialize daemon inventory/AppKit systems.
- Cold/warm startup and request latency benchmark command exists.
