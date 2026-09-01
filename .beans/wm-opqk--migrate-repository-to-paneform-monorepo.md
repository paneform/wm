---
# wm-opqk
title: Migrate repository to Paneform monorepo
status: completed
type: feature
priority: normal
created_at: 2026-08-31T23:30:59Z
updated_at: 2026-09-01T06:35:21Z
---

Rename and restructure the workspace under the Paneform package identities, prepare public layout packages, and align the macOS bundle identity.

## Todo

- [x] Move and rename workspaces and package imports
- [x] Make `@paneform/layout` publishable
- [x] Make `@paneform/layout-browser` publishable without import side effects
- [x] Move the private `@paneform/wm` app composition root under `apps/wm`
- [x] Rename the bundle to `wm.app` and use `com.paneform.wm`
- [x] Update scripts, documentation, tests, and lockfile
- [x] Run focused and full validation

## Implementation Plan

### 1. Workspace boundaries

- Move `packages/engine` to `packages/layout` and rename it `@paneform/layout`.
- Move `packages/renderer` to `packages/layout-browser` and rename it `@paneform/layout-browser`.
- Move `packages/node-host` to `apps/wm` and rename it private `@paneform/wm`; retain the `wm` binary name.
- Keep the macOS adapter as a private workspace and rename it `@paneform/wm-macos`.
- Expand `pnpm-workspace.yaml` to include `apps/*`.

### 2. Public package artifacts

- Give `@paneform/layout` a dedicated emit configuration producing ESM JavaScript, declarations, declaration maps, and source maps under `dist/`.
- Use Node ESM `.js` source specifiers so emitted JavaScript and declarations resolve correctly.
- Export only built files and include public package metadata.
- Start both public packages at `0.1.0-alpha.0`; retain the WM product version separately.
- Validate each package with `pnpm pack` and inspect its archive contents.

### 3. Browser package API

- Split the current auto-starting Vite entry from the public side-effect-free library entry.
- Add an explicit container-based mount API so the package does not depend on document-wide IDs or own the consumer page.
- Keep a local Vite playground as an example and development harness.
- Scope renderer styles to its mount root and expose them explicitly.
- Have `@paneform/layout-browser` declare a compatible `@paneform/layout` peer dependency and use the workspace package for development.

### 4. macOS identity

- Rename every bundle path and diagnostic from `WM.app` to `wm.app`.
- Change the bundle and launchd identity from `com.allandeutsch.wm` to `com.paneform.wm`.
- Keep the executable and CLI command as lowercase `wm`.
- Continue bundling the verified Node 24 runtime; do not add a Homebrew Node dependency.

### 5. Repository consistency

- Update imports, scripts, documentation, diagrams, tests, package metadata, and the pnpm lockfile.
- Preserve existing functionality and avoid compatibility aliases for unpublished `@wm/*` names.

### 6. Validation

- Run package typechecks and focused tests while resolving migration failures.
- Run the full TypeScript and Swift test suites, lint, build, and package dry runs.
- Verify generated JavaScript contains no relative `.ts` imports and public tarballs contain only intended files.

## Out of Scope

- Creating the separate `paneform/site` repository.
- Publishing npm packages or transferring the GitHub repository.
- Developer ID notarization and the production Homebrew Cask workflow.

## Distribution Decision

The application will continue to bundle Node. This keeps `wm.app` self-contained and avoids Homebrew-prefix and launchd runtime discovery problems.

## Summary of Changes

- Restructured the repository into public `@paneform/layout` and `@paneform/layout-browser` packages plus private `@paneform/wm` and `@paneform/wm-macos` workspaces.
- Added publishable ESM artifacts, declarations, package metadata, MIT licenses, pnpm-only publication guards, and a side-effect-free browser mount and simulator API.
- Migrated the macOS bundle and launchd identity to lowercase `wm.app` and `com.paneform.wm`, including cleanup for the legacy identity.
- Updated scripts, imports, documentation, diagrams, tests, and the pnpm lockfile.
- Passed focused browser checks, full workspace typecheck, lint, tests, build, package archive inspection, clean-consumer package imports, and the bundled CLI smoke test.
