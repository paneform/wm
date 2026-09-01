---
# wm-xchk
title: Re-review packages/layout anti-slop fixes
status: completed
type: task
priority: normal
created_at: 2026-09-01T07:59:27Z
updated_at: 2026-09-01T08:04:41Z
---

Re-review current uncommitted packages/layout changes after fixes for wm-dlj5. Code review only; do not edit package files.

- [x] Verify all seven original findings against source and declarations
- [x] Inspect finite JSON Schema semantics and tests
- [x] Inspect current diff for new regressions
- [x] Run package lint, typecheck, tests, and declaration build
- [x] Record and deliver the final review

## Findings

1. **High — Original public wire-contract finding remains unresolved and breaks a workspace consumer.** `packages/layout/src/transport.ts:29-45` changes successful `WireResponse.data` from `unknown` to `JsonValue`. Generic input on `wireResponseOk` does not preserve compatibility for callers that construct `WireMessage` directly. Root `pnpm run typecheck` now fails at `apps/wm/src/ws-server.ts:79` because the command handler returns `unknown`. Preserve the public response contract and validate at the serialization boundary, or migrate all consumers as a coordinated API change.

2. **Medium — The recursive JSON decoder accepts non-JSON object instances and silently changes them.** `packages/layout/src/schema.ts:13-21` uses `Schema.Record` without a plain-object refinement, and `packages/layout/src/transport.ts:81-105` returns decoded values. A `Date` is accepted and decoded to `{}` (instead of being rejected); nested Dates in domain events are likewise erased. Add a plain-record predicate/refinement and tests for Date, Map, and class instances so validation rejects rather than transforms non-JSON containers.

3. **Medium — Public declaration emission expands the recursive schema into depth-limited `any`.** The unannotated schema exports at `packages/layout/src/transport.ts:29-54` emit hundreds of lines in `packages/layout/dist/transport.d.ts:117-170,182-...`, including `/*elided*/ any`. This weakens the promised recursive payload type and creates an unstable declaration surface. Export a nameable JSON definition and/or explicitly annotate the wire schemas with named public types.

4. **Low — Invalid-command wire tests reject before exercising the wire decoder.** `packages/layout/test/schema.spec.ts:322-366` calls `decodeCommandSync` inside `requestEnvelope`; malformed directions, missing fields, and excess fields throw there, so `encodeWireMessage` and `decodeWireMessage` never run. Keep the typed encoder path for valid round trips, but build raw malformed JSON frames for decoder rejection cases.

## Original finding verification

- Restored `makeProfileKey`: resolved.
- `decodeCommandSync` accepts `unknown`: resolved.
- JSON contract: finite numbers are enforced, but public compatibility and object semantics remain problematic (findings 1-2).
- Stable `noteExactFrame` return declaration: resolved.
- Valid encode/decode round trip: resolved; malformed wire tests remain weakened (finding 4).
- Fake optional fields are omitted and covered: resolved.
- Internal profile-key Schema failures normalize to `ObservationStoreError`: resolved, though no focused regression test was added.

## Validation

Package lint, typecheck, declaration build, and all 314 tests pass. Workspace typecheck fails at `apps/wm/src/ws-server.ts:79`, proving package-only checks are not sufficient for the public API change.

## Summary of Changes

Re-reviewed all seven original findings, the finite JSON schema and tests, generated declarations, and workspace consumers. Found four remaining or newly introduced issues.
