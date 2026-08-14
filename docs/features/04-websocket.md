# Feature 04: WebSocket Daemon Frontend

Owns loopback listener, HTTP upgrade, Origin policy, frame parsing, connection
lifecycle, request correlation, subscription routing, bounded outbound queues,
and JSON text frames.

Dependencies: protocol contracts and shared request handler.

Does not own domain behavior or macOS inventory.

Acceptance criteria:

- Fixed configurable host/port and `/v1` path.
- Port conflict fails clearly.
- Browser origins denied by default; exact allowlist works.
- Non-browser clients are accepted.
- Inbound size bound and malformed-message errors are enforced.
- Slow clients disconnect without blocking state work.
