# Releases

`@paneform/layout` and `@paneform/layout-browser` are published together from Git tags. The
layout package is always published first because the browser package declares it as a peer.

## Prepare A Release

1. Update both package versions to the same semantic version.
2. Update the browser package's `@paneform/layout` peer range when compatibility changes.
3. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
4. Commit and push the release preparation to `main`.
5. Tag that commit as `v<version>` and push the tag.

The `publish.yml` workflow validates the tag against both package versions, checks and tests both
packages, creates pnpm-transformed tarballs, and publishes those tarballs through npm trusted
publishing. Tags must point to commits on `main`. Prereleases use the `alpha`, `beta`, or `next`
dist-tag. Stable versions use `latest`.

## Trusted Publishing

Each npm package trusts the `paneform/wm` GitHub repository, the `publish.yml` workflow, and the
`npm` GitHub environment. The relationship can be inspected with:

```sh
npm trust list @paneform/layout
npm trust list @paneform/layout-browser
```

Do not add an npm token to GitHub. The publishing job uses short-lived OpenID Connect credentials
and receives `id-token: write` only after the build and package validation job succeeds.

The first version of a new package must be published interactively before npm allows trusted
publishing to be configured. After that bootstrap, set publishing access to require two-factor
authentication and disallow tokens.
