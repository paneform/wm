---
# wm-dlj5
title: Review packages/layout anti-slop changes
status: completed
type: task
priority: normal
created_at: 2026-09-01T07:37:31Z
updated_at: 2026-09-01T07:45:24Z
---

Code review only of uncommitted packages/layout changes relative to HEAD. Do not edit package files.

- [x] Inspect production diffs and surrounding contracts
- [x] Inspect changed tests for weakened intent
- [x] Run package lint, typecheck, and tests
- [x] Record findings with location, impact, and mitigation
- [x] Deliver review ordered by severity

## Findings

1. **Medium — Exported helper was renamed without compatibility.** `packages/layout/src/learn.ts:148` replaces public `makeProfileKey` with `profileKeyFromInput`; `src/index.ts` exports this module. Existing consumers stop compiling. Restore the old name or export a compatibility alias.

2. **Medium — A public decoder no longer accepts untrusted input.** `packages/layout/src/commands.ts:490` types the input as the already-valid encoded command even though `decodeCommandSync` is exported at line 623. Callers holding `unknown` can no longer use the validator without a cast. Keep the boundary parameter `unknown`.

3. **Medium — New JSON payload contracts are both breaking and unsound.** `packages/layout/src/events.ts:23-46` and `packages/layout/src/transport.ts:12-18,86-95` narrow public parameters from unknown records/values, but the Effect schemas still use `Schema.Unknown`; `number` also admits NaN and Infinity. These values pass the event validator, while JSON encoding changes them to null. Either retain the old public signatures or define and use one recursive runtime JSON schema with finite numbers.

4. **Medium — Removing an exported return annotation changed the generated declaration.** `packages/layout/src/learn.ts:324-329` now emits a branch union containing `replaced: never[]` and an implementation-shaped store instead of `{ store: LearningStore; replaced: ConstraintCandidate[] }`. This can break downstream mutation/contextual typing. Restore the explicit public return type.

5. **Low — The named wire round-trip test no longer exercises the encoder.** `packages/layout/test/schema.spec.ts:296-320` replaced `encodeWireMessage` with `JSON.stringify`, so the valid hotkey test now covers only decode. Use a typed `WireRequest` and `encodeWireMessage` for the valid round-trip; keep raw JSON only for rejection cases.

6. **Low — The fake platform stopped modeling absent optional observation fields.** `packages/layout/test/helpers/fake-platform.ts:571-587` now emits own properties whose values are undefined. Effect Schema preserves that distinction, while JSON-backed production observations omit those keys. This weakens coverage of absent-property behavior. Add optional fields conditionally as before, or test both representations.

7. **Low — Internal key Schema failures escape the documented store error family.** `packages/layout/src/observation-store.ts:193-216` calls `Schema.decodeUnknownSync` outside a wrapper. Invalid empty/NUL segments now throw a Schema parse error rather than `ObservationStoreError("invalid")`, unlike the previous decoder. Catch and normalize this error.

## Validation

`pnpm run lint`, `pnpm run typecheck`, `pnpm run test` (18 files, 304 tests), and `pnpm run build` pass in `packages/layout`. These checks are not sufficient: they do not compare the published declaration/API against HEAD, there are no direct event-payload boundary tests, and changed fixtures/tests now encode the new assumptions.

## Summary of Changes

Reviewed the complete uncommitted `packages/layout` diff relative to HEAD without editing package source or test files. Recorded seven API, validation, declaration, and test-contract findings.
