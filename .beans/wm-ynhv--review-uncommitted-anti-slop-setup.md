---
# wm-ynhv
title: Review uncommitted anti-slop setup
status: completed
type: task
priority: normal
created_at: 2026-09-01T07:37:39Z
updated_at: 2026-09-01T07:48:12Z
---

Review only the uncommitted anti-slop setup files requested by the user. Do not modify implementation files.

## Plan

- [x] Inspect the scoped uncommitted diff and surrounding workspace/config context.
- [x] Compare vendoring, dependency resolution, rules, ignores, and package scope with upstream guidance.
- [x] Run focused configuration/lint validation without changing files.
- [x] Record concrete findings with locations, impact, and mitigation.
- [x] Deliver the review and residual risks.

## Findings

### High — Vendored MIT source lacks its required copyright and permission notice

- Location: `tools/oxlint/anti-slop/**` (the vendored tree has no `LICENSE` or notice); the repository also has no root `LICENSE`. The copied entry point begins directly with source at `tools/oxlint/anti-slop/index.ts:1`.
- Issue: The production files exactly match the official install skill assets at upstream commit `e8c4880471b23ab7f216fba7b27d173a6ef07d4c`, but the upstream MIT license says its copyright and permission notice must be included in copies or substantial portions.
- Impact: Committing or redistributing this vendored source without the notice creates a license-compliance gap and removes useful provenance for future upgrades.
- Mitigation: Vendor the upstream `LICENSE` beside the plugin (or in a third-party notices file that clearly covers it) and record the source repository and commit/version.

### Low — Shared config points its schema URI at a file that does not exist

- Location: `anti-slop.oxlintrc.json:2`; root dependencies are listed at `package.json:16-18`.
- Issue: `$schema` is `./node_modules/oxlint/configuration_schema.json`, but root `node_modules` has no `oxlint` because Oxlint is installed only in workspace packages. Runtime ignores `$schema`, so linting still works.
- Impact: Editors and JSON tooling cannot validate or complete the shared config, making configuration mistakes easier to miss.
- Mitigation: Use a resolvable schema URI or install exact `oxlint@1.80.0` at the root alongside `@oxlint/plugins`.

## Validation

- Compared the vendored tree byte-for-byte with the official skill assets: no production-file drift or omissions.
- Confirmed upstream `main` is `e8c4880471b23ab7f216fba7b27d173a6ef07d4c`.
- Confirmed lockfile resolution has one `oxlint` version and one `@oxlint/plugins` version, both `1.80.0`.
- Public package lint commands pass. A known violation is reported as an anti-slop error through both public package configs, proving `extends` and plugin path resolution work.
- The same probe under both private workspaces produces no anti-slop diagnostic, proving policy is not applied there.
- Confirmed all 15 generic rules and the Effect rule are configured as errors; both public packages directly depend on Effect.
- Confirmed the vendored plugin ignore suppresses `tools/oxlint/anti-slop/**`.
- `git diff --check` passes.

## Summary of Changes

Reviewed only the requested uncommitted anti-slop setup. No implementation files were edited. Recorded two findings and validated dependency matching, config inheritance, rule severity, Effect opt-in, ignores, vendored asset completeness, and public-package-only scope.
