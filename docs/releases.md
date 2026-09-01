# Releases

`@paneform/layout` and `@paneform/layout-browser` are staged together from Git tags. A maintainer
reviews and approves both packages on npm before they become public. The layout package is always
staged first because the browser package declares it as a peer.

## Prepare A Release

1. Update both package versions to the same semantic version.
2. Update the browser package's `@paneform/layout` peer range when compatibility changes.
3. Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`.
4. Commit and push the release preparation to `main`.
5. Tag that commit as `v<version>` and push the tag.

The `publish.yml` workflow validates the tag against both package versions, checks and tests both
packages, creates pnpm-transformed tarballs, and submits those tarballs with npm staged publishing.
Tags must point to commits on `main`. Prereleases use the `alpha`, `beta`, or `next` dist-tag. Stable
versions use `latest`.

After the workflow succeeds, review both entries in the npm **Staged Packages** tab. Approve the
layout package first, then approve the browser package. npm requires 2FA for each approval.

## Trusted Publishing

Each npm package trusts the `paneform/wm` GitHub repository, the `publish.yml` workflow, and the
`npm` GitHub environment for stage-only access. The relationship can be inspected with:

```sh
npm trust list @paneform/layout
npm trust list @paneform/layout-browser
```

Do not add an npm token to the normal release workflow. The staging job uses short-lived OpenID
Connect credentials and receives `id-token: write` only after the build and package validation job
succeeds.

## Initial Bootstrap

npm cannot stage a brand-new package or configure it for trusted publishing. Both package names
were therefore reserved as `0.0.0` under the `bootstrap` tag before stage-only trust was enabled.
The temporary bootstrap workflow and npm secret have been removed.

Any future package name will require the same one-time reservation. Use a short-lived token in the
protected `npm` environment, then delete the workflow and secret immediately after configuring
stage-only trust.
