---
# wm-4ubm
title: Final re-review packages/layout JSON wire fixes
status: completed
type: task
priority: normal
created_at: 2026-09-01T08:12:53Z
updated_at: 2026-09-01T08:15:01Z
---

Final code-only re-review of current uncommitted packages/layout changes. Do not edit package files.

- [x] Verify workspace wire compatibility
- [x] Verify non-plain JSON objects are rejected
- [x] Verify stable declarations contain no elided any
- [x] Verify malformed tests reach decodeWireMessage
- [x] Scan full current diff and run validation
- [x] Record and deliver final result

## Finding

1. **Medium — Decoded legacy wire messages can no longer be re-encoded.** `packages/layout/src/transport.ts:94-96` validates the whole message with `JsonValueSchema` before stringifying. However, `decodeWireMessage` intentionally preserves the established `Schema.Unknown` behavior in which missing response `data` or event `payload` becomes an own property with value `undefined`, as asserted at `packages/layout/test/schema.spec.ts:415-419`. Passing either decoded result to `encodeWireMessage` now throws, whereas HEAD serialized it with the undefined property omitted. The same mismatch applies to otherwise valid typed snapshots containing explicit undefined optional properties. Preserve JSON.stringify omission semantics for undefined optional envelope fields while separately validating present unknown payload/data values, and add decode-then-encode coverage for the legacy frames.

## Verification of prior findings

- Workspace compatibility: resolved; recursive workspace typecheck passes.
- Non-plain object rejection: resolved for direct and nested values, with Date/class tests.
- Stable declarations: resolved; generated wire declarations use named types and contain no `/*elided*/ any`.
- Malformed tests: resolved; raw frames now reach `decodeWireMessage`.

## Validation

Package lint, typecheck, declaration build, and all 317 tests pass. Recursive workspace typecheck also passes. A direct runtime check confirms that decoding either supported missing-field frame and then calling `encodeWireMessage` throws.

## Summary of Changes

Completed the final JSON/wire re-review. The four reported fixes are present, but the new whole-message JSON validation introduces one round-trip regression.
