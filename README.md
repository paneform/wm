# Paneform

Paneform is a portable window-layout engine and macOS window manager.

## Packages

| Package                                               | Description                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| [`@paneform/layout`](packages/layout)                 | Platform-independent layout, workspace, and reconciliation engine  |
| [`@paneform/layout-browser`](packages/layout-browser) | Browser renderer and deterministic virtual window-system simulator |

Both public packages are currently alpha releases. Install them with the `alpha` tag.

```sh
npm install @paneform/layout@alpha
npm install @paneform/layout-browser@alpha
```

## Development

The repository requires Node.js 24 and pnpm 11.24.0.

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

See [`docs/releases.md`](docs/releases.md) for the npm release process.
