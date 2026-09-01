---
# wm-l6rn
title: Review layout-browser anti-slop changes
status: completed
type: task
priority: normal
created_at: 2026-09-01T07:37:32Z
updated_at: 2026-09-01T07:42:41Z
---

Review uncommitted packages/layout-browser changes against HEAD for behavioral regressions and API, validation, lifecycle, assertion, and coverage issues. Code review only; do not modify package files.

## Plan

- [x] Inspect the full diff and relevant surrounding code.
- [x] Compare changed behavior with HEAD and public call sites/tests.
- [x] Run package lint, typecheck, and tests without changing files.
- [x] Record prioritized findings with exact locations and validation status.
- [x] Deliver the review.

## Findings

### P2 — One invalid recording can hide and later delete every valid recording

- Location: packages/layout-browser/src/ui/scenarios.ts:353-382, especially 375-382.
- Issue: The whole localStorage dictionary is decoded in one operation. Any malformed, stale, or excess field in one recording makes loadRecordings return an empty object. A later save then serializes that empty object plus the new recording, permanently deleting valid sibling recordings.
- Impact: Existing user scenario data can disappear because one entry does not match the new strict schema.
- Mitigation: Validate recordings independently and preserve valid siblings. Refuse to overwrite a store containing unhandled invalid entries, or retain/quarantine their raw values. Add mixed-validity and save-preservation tests.

### P3 — JSON-regex substitution no longer supports all valid scenario ref strings

- Location: packages/layout-browser/src/ui/scenarios.ts:190-198.
- Issue: The new regex runs on JSON-escaped text rather than decoded strings. Refs containing backslashes, quotes, or control characters no longer match their Map keys. An empty ref is not matched at all because the capture uses +. ScenarioOp and its schema accept every string.
- Impact: Valid custom/recorded scenarios can fail with unknown refs or send the unresolved @w: placeholder.
- Mitigation: Substitute decoded string values with a JSON.parse reviver or a typed command traversal, then schema-decode the result. Test escaped and empty refs.

### P3 — Nominal CommandError checks narrow public Engine interoperability

- Location: packages/layout-browser/src/host.ts:94-104 and 125-128.
- Issue: Timeout handling changed from reading the typed error payload to instanceof CommandError. Errors from another realm, a duplicated peer package, or a compatible custom Engine implementation do not pass that identity check.
- Impact: mountLayoutRenderer can misreport a timeout as a hard error; scenario execution also reports it as failed rather than deferred.
- Mitigation: Use a schema/type guard for the tagged error payload instead of constructor identity. Test a structurally valid timeout from a separate/custom Engine boundary.

## Validation

- pnpm run lint: passed.
- pnpm run typecheck: passed.
- pnpm run test: passed (2 files, 24 tests).
- These checks are not sufficient for the changed behavior: tests do not exercise localStorage decoding/save recovery, unusual placeholder refs, raw-command DOM validation, renderer mounting, refresh concurrency, stop behavior, or cross-boundary errors.

## Summary of Changes

Reviewed the uncommitted layout-browser diff against HEAD without modifying package code. Recorded three behavioral findings and current package-check results.
