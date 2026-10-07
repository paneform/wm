<script lang="ts">
  import { page } from "$app/state";
  import type { Snippet } from "svelte";
  import PaneformWordmark from "./PaneformWordmark.svelte";

  let { docsSearch, playgroundEnabled = false }: { docsSearch?: Snippet; playgroundEnabled?: boolean } = $props();
  const inDocs = $derived(page.url.pathname.startsWith("/wm/docs"));
</script>

<header class="site-header" class:with-search={!!docsSearch}>
  <a class="wordmark" href="/wm/" aria-label="Paneform WM home"><PaneformWordmark clipId="site-logo" /></a>
  <nav aria-label="Main navigation">
    <a href="/wm/docs/" aria-current={inDocs ? "page" : undefined}>Docs</a>
    {#if playgroundEnabled}<a href="/wm/play/">Playground ↗</a>{/if}
  </nav>
  {#if docsSearch}<div class="search">{@render docsSearch()}</div>{/if}
</header>

<style>
  .site-header { position: sticky; top: 0; z-index: 10; display: flex; align-items: center; gap: 1.25rem; min-height: 4rem; padding: 0.5rem var(--page-gutter); border-bottom: 1px solid var(--color-line-default); background: color-mix(in srgb, var(--rp-base) 88%, transparent); backdrop-filter: blur(10px); font: 600 0.875rem var(--type-family-system); }
  .wordmark { width: clamp(6rem, 16vw, 9rem); flex-shrink: 0; }
   nav { display: flex; align-items: center; gap: 1rem; }
  a { color: var(--color-page-secondary); text-decoration: none; }
  nav a { display: flex; align-items: center; min-height: var(--control-target); }
  a:hover, a[aria-current] { color: var(--color-page-foreground); }
  a[aria-current] { text-decoration: underline; text-underline-offset: 0.35em; }
  a:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 3px; }
   .search { width: min(20rem, 30vw); margin-inline-start: auto; }
  @media (max-width: 42rem) {
    .site-header { gap: 0.75rem; }
    .with-search { flex-wrap: wrap; }
    nav { gap: 0.75rem; font-size: 0.8125rem; }
    .search { width: 100%; padding-bottom: 0.25rem; }
  }
</style>
