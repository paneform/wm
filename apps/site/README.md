# Paneform site

The landing (`/wm/`) and embedded waitlist (`/wm/waitlist/`) are prerendered.
The domain root redirects to `/wm/`. Signup posts directly to Loops; do not add
private Loops API keys to this app.

## Playground

The entire `/wm/play/` route tree, including its JSON schema, requires server
requests and is disabled by default. Vercel production always returns 404,
even if `PLAYGROUND_ENABLED=true` is accidentally configured there.

For local development:

```sh
PLAYGROUND_ENABLED=true pnpm --filter @paneform/site dev
```

For a Vercel preview, set `PLAYGROUND_ENABLED=true` in the **Preview** environment
only. Enable Vercel Deployment Protection for those previews. The flag is a
release gate, not authentication. Do not promote an enabled preview to production;
create a production deployment with production environment settings instead.

## Vercel

The `paneform` Vercel project is connected to `https://github.com/paneform/wm`.
Pushes to `main` trigger production deployments; other branches create previews.
Release through the repository, not manual CLI source uploads. The production
domain is `paneform.com`; deployment URLs and previews use Vercel authentication.

- Project root: `apps/site`.
- Include source files outside the root directory: enabled (workspace packages).
- Framework: SvelteKit. Build command: `pnpm run build` (includes snapshot generation).
- Node: 24.x. Set `ENABLE_EXPERIMENTAL_COREPACK=1` to honor the root pnpm version.
- Leave Output Directory unset; `adapter-vercel` generates the deployment output.
- Do not deploy the old `build/` directory from the former static adapter.
- Keep `PLAYGROUND_ENABLED` unset in Production.

Run tests, lint, typecheck and build before deploying. Check the root redirect,
landing, waitlist frame and playground 404s on the deployed URL before mapping
`paneform.com`. Signup persistence should be confirmed in Loops with a controlled
address, not by automated smoke tests that create real contacts.

After building, run `pnpm --filter @paneform/site check:release` from the workspace
root. It checks prerendered output, social assets and all three gate modes against
local preview servers. Vite preview serves the root's generated redirect document;
the Vercel adapter emits the actual HTTP 308 redirect.

## Sharing

The landing and waitlist share `/social/paneform-wm.png`, a 1200x630 image with
Open Graph and Twitter large-card metadata. With a local landing server running,
regenerate it from the development-only `/wm/og/` route with
`pnpm --filter @paneform/site render:og`.
Set `WM_SCREENSHOT_URL` when the landing is not at `http://127.0.0.1:4192/wm/`.
The renderer uses dark mode and reduced motion, waits for the actual demo to finish
and the waitlist iframe/fonts to load, then captures the page without changing its
window contents. `/wm/og/` is unavailable in all built deployments, including
playground-enabled previews. It is only available through the development server.
The image and `/favicon.svg` remain public regardless of the playground flag.
Social metadata uses an image URL version (`?v=2`) so fresh scrapes can distinguish
the approved dark screenshot from the previous artwork.
