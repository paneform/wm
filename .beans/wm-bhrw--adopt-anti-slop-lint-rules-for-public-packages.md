---
# wm-bhrw
title: Adopt anti-slop lint rules for public packages
status: completed
type: task
priority: normal
created_at: 2026-09-01T06:56:16Z
updated_at: 2026-09-01T08:26:19Z
---

Configure anti-slop Oxlint rules for `@paneform/layout` and `@paneform/layout-browser`, run one delegated lint-and-fix pass per package, and validate the resulting changes.

## Todo

- [x] Review current anti-slop installation and Oxlint configuration guidance
- [x] Configure anti-slop for both public packages
- [x] Run and address delegated `@paneform/layout` lint findings
- [x] Run and address delegated `@paneform/layout-browser` lint findings
- [x] Run focused and full validation

## Review Findings

- `packages/layout/src/learn.ts:148,324`: lint cleanup renamed an exported helper and leaked inferred branch types, risking downstream source and declaration compatibility. Mitigation: restore the existing export and named result contract while avoiding the Effect import-name false positive at internal call sites.
- `packages/layout/src/commands.ts:490`: the public decoder was narrowed from untrusted input to an encoded command type, forcing boundary callers to cast. Mitigation: retain an `unknown` public boundary and delegate immediately to schema decoding through a lint-compliant wrapper.
- `packages/layout/src/events.ts:23-46` and `src/transport.ts:12-95`: recursive JSON types were not backed by the runtime schemas and admitted non-finite numbers. Mitigation: define and reuse one recursive finite JSON schema for payload types and wire validation.
- `packages/layout/src/observation-store.ts:193-216`: profile-key schema failures escaped the `ObservationStoreError` contract. Mitigation: catch and normalize parse failures.
- `packages/layout/test/schema.spec.ts:296-320` and `test/helpers/fake-platform.ts:571-587`: lint changes weakened wire-encoding and omitted-option test fidelity. Mitigation: restore typed encoder use and explicit optional-property omission.
- `packages/layout-browser/src/ui/scenarios.ts:353-382`: one malformed persisted recording discarded all valid siblings and a later save could erase them. Mitigation: decode entries independently and preserve valid recordings.
- `packages/layout-browser/src/ui/scenarios.ts:190-198`: substitution over JSON-escaped text mishandled escaped or empty references. Mitigation: traverse decoded command values and schema-decode the result.
- `packages/layout-browser/src/host.ts:94-128`: `instanceof CommandError` broke timeout recognition across realms or duplicate peer instances. Mitigation: structurally schema-decode the tagged error.
- `tools/oxlint/anti-slop/**` and `anti-slop.oxlintrc.json:2`: vendored source lacked its MIT notice and the root schema path lacked a root Oxlint dependency. Mitigation: vendor upstream LICENSE/source revision metadata and pin root `oxlint` to `1.80.0`.

## Review Resolution

All recorded findings were resolved and re-reviewed. Public helper and decoder contracts were preserved; JSON and wire validation now reject coercive values while retaining legacy undefined-property omission; observation errors remain normalized; browser recording recovery, reference substitution, and structural timeout handling have regression coverage; and vendored licensing and dependency resolution are complete. Final package re-reviews reported no actionable findings.

## Summary of Changes

- Vendored anti-slop commit `e8c4880471b23ab7f216fba7b27d173a6ef07d4c` under `tools/oxlint/anti-slop/` with its MIT license and source metadata.
- Pinned root `oxlint` and `@oxlint/plugins` to `1.80.0`, enabled all generic rules plus the Effect rule, and scoped the shared policy to `@paneform/layout` and `@paneform/layout-browser`.
- Ran dedicated package agents and resolved all reported lint findings without rule suppressions.
- Added boundary and regression coverage; layout now passes 323 tests and layout-browser passes 31 tests.
- Passed full workspace lint, typecheck, TypeScript and Swift tests, build, package formatting, declaration integrity, vendored-source comparison, and `git diff --check`.
