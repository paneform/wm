---
# wm-7xkd
title: Recommend docs demo architecture
status: completed
type: task
priority: normal
created_at: 2026-09-28T17:41:56Z
updated_at: 2026-09-28T18:02:14Z
---

Assess maintainable ways to author and run command-reference examples against the current docs implementation and design spec.

## Plan

- [x] Examine scenario authoring, catalog linkage, player lifecycle and validation.
- [x] Compare three viable approaches against source-of-truth, simplicity and reader experience.
- [x] Record concrete recommendation, tradeoffs and validation strategy.

## Findings

- `apps/site/src/lib/docs/demo-data.ts:21-35` and `packages/layout/src/command-docs.ts:137-164`: the site owns a second page-slug map and eager-imports all five demo documents. Impact: new commands can silently lack demos, unused files are not detected, and reference pages load unrelated scenarios. Mitigations: explicit lightweight page-to-situation manifest with checked file IDs; route-scoped lazy imports and orphan checks.
- `apps/site/test/docs.spec.ts:33-46`: checks one step and no throw, not the claim in its caption. Impact: a demo can still pass when its behavior is wrong or a no-op should have changed something. Mitigations: assert relevant before/after focus, workspace membership and geometry relations; require one meaningful expectation per situation.
- `apps/site/src/lib/docs/demos/*.json` and `apps/site/src/lib/docs/DemoStage.svelte:67-70`: five files repeat the same config/presentation/topology and tab previews render authored pre-reconcile frames. Impact: authoring drift and preview/initial-stage mismatch when tiling defaults change. Mitigations: keep self-contained scenarios as source, validate shared rules and generate previews from reconciled initial snapshots; consider lightweight authoring helpers only if repeated edits become painful.
- `apps/site/src/lib/docs/DemoStage.svelte:19-59`: player rebuilds and reconciles a session on each selection/reset; no worker. Impact: fine for small one-step demos but new pages can multiply eager bundle cost and demo state/motion behavior. Mitigations: import only selected demo, one disposable session per active situation, render the same scenario in the playground and docs stage.

## Recommendation

Prefer small, self-contained, committed one-command `LayoutScenario` JSON fixtures for the actual demonstrations, with a typed site-owned manifest that maps stable command page slugs to situations, labels and lazy asset imports. Keep syntax, command semantics and invocation metadata in `@paneform/layout`; author only educational situation selection and framing in docs. Reconcile setup through the actual engine, then run the one step through the shared runner/stage. Validate referential integrity and semantic before/after claims, not only parse/success, and require deliberate demo coverage or an explicit exemption for commands that cannot be simulated. Use distinct terminal scripts for local CLI-only commands. Preserve fixed concrete values and compute playground links only on click.

Alternative 1: typed TypeScript scene builders compile smaller recipes to `LayoutScenario`: reduces duplicated geometry and envelope settings, but adds a new domain-specific authoring language and makes the portable scenario less directly inspectable. Suitable once repetition is proven costly.

Alternative 2: repurpose engine test fixtures as demo sources: strongest reuse of existing test scenarios, but tests optimize for edge coverage rather than one-screen pedagogy and can change for test reasons. Better for selected regression examples than the primary docs content model.

Validation of this recommendation: compared existing spec, docs files, runner and test coverage; executed all five committed demos through reconcile plus the real command and observed swap, edge expansion, edge no-op, empty-workspace follow and populated-workspace retile. No code changes were requested or made.

## Summary of Changes

Reviewed the docs spec, command registry, scenario schema/runner, manifest, renderer and tests. Recorded findings with code locations, impact and mitigation options, recommended self-contained scenario fixtures plus a typed docs manifest and semantic checks, and compared TypeScript scene recipes and engine-test-fixture reuse. Confirmed actual before/after behavior of all five current demos. This was a design recommendation; no application code changed.
