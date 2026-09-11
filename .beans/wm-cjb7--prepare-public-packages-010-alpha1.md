---
# wm-cjb7
title: Prepare public packages 0.1.0-alpha.1
status: completed
type: task
priority: normal
created_at: 2026-09-11T21:49:12Z
updated_at: 2026-09-11T21:52:58Z
---

## Plan

- [x] Update public package versions and browser peer range; refresh dependency installation.
- [x] Run formatting, pnpm lint, pnpm typecheck, pnpm test, and pnpm build.
- [x] Commit and push release preparation to main.
- [x] Tag and push v0.1.0-alpha.1; verify the npm staging workflow.

npm approval remains a maintainer action. Do not deploy the native app.

## Validation

Both public versions are 0.1.0-alpha.1; browser peer range is >=0.1.0-alpha.1 <1. pnpm install required no lockfile changes. Formatting, lint, typecheck, full tests (588 TypeScript and 16 Swift), and build passed. Remote tag was absent; origin/main has eight existing local commits pending push.

## Summary of Changes

Prepared both public packages at 0.1.0-alpha.1 and updated the browser peer range. Release commit b793c94 and annotated tag v0.1.0-alpha.1 were pushed to origin. Main CI passed. Release validation, tests, packing, and packed-manifest checks passed in https://github.com/paneform/wm/actions/runs/34651283615.

## Maintainer Handoff

Stage on npm is waiting for approval of the GitHub npm environment by Masstronaut. No environment approval or npm approval was performed. After GitHub approval, wait for staging success and approve layout first, then layout-browser on npm. The release tag remains on b793c94; this record does not change release artifacts.
