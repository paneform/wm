---
# wm-cjb7
title: Prepare public packages 0.1.0-alpha.1
status: in-progress
type: task
priority: normal
created_at: 2026-09-11T21:49:12Z
updated_at: 2026-09-11T21:50:08Z
---

## Plan

- [x] Update public package versions and browser peer range; refresh dependency installation.
- [x] Run formatting, pnpm lint, pnpm typecheck, pnpm test, and pnpm build.
- [ ] Commit and push release preparation to main.
- [ ] Tag and push v0.1.0-alpha.1; verify the npm staging workflow.

npm approval remains a maintainer action. Do not deploy the native app.

## Validation

Both public versions are 0.1.0-alpha.1; browser peer range is >=0.1.0-alpha.1 <1. pnpm install required no lockfile changes. Formatting, lint, typecheck, full tests (588 TypeScript and 16 Swift), and build passed. Remote tag was absent; origin/main has eight existing local commits pending push.
