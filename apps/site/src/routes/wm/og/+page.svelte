<script lang="ts">
  import PaneformWordmark from "$lib/hero/PaneformWordmark.svelte";
  import WmHero from "$lib/hero/WmHero.svelte";
</script>

<main class="og-page">
  <section class="og-copy" aria-labelledby="og-heading">
    <div class="og-wordmark"><PaneformWordmark clipId="paneform-og-clip" /></div>
    <h1 id="og-heading">
      <span>A tiling window manager</span>
      <span class="tagline"><em>that just works</em>.</span>
    </h1>
  </section>
  <section class="og-product" aria-label="Paneform WM running on a MacBook">
    <WmHero />
  </section>
</main>

<svelte:head>
  <title>Paneform WM social image</title>
  <meta name="robots" content="noindex, nofollow" />
  <meta name="theme-color" content="#191724" />
</svelte:head>

<style>
  :global(html:has(.og-page)),
  :global(body:has(.og-page)) {
    width: 1200px;
    height: 630px;
    overflow: hidden;
  }

  .og-page {
    display: grid;
    grid-template-columns: 43% 57%;
    width: 1200px;
    height: 630px;
    overflow: hidden;
    background: var(--color-page-background);
    color: var(--color-page-foreground);
  }

  .og-copy {
    z-index: 2;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 0 0 1.5rem 4.75rem;
  }

  .og-wordmark {
    width: 21.875rem;
    margin-block-end: 4.125rem;
  }

  h1 {
    display: flex;
    flex-direction: column;
    margin: 0;
    font-size: 2rem;
    font-weight: var(--type-weight-medium);
    line-height: 1.17;
    letter-spacing: -0.04em;
  }

  h1 span {
    white-space: nowrap;
  }

  .tagline {
    color: var(--rp-rose);
    font-weight: var(--type-weight-strong);
  }

  .og-product {
    position: relative;
    min-width: 0;
    overflow: hidden;
  }

  .og-product :global(.wm-landing) {
    display: block;
    width: 100%;
    height: 630px;
  }

  .og-product :global(.hero) {
    display: block;
    height: 630px;
  }

  .og-product :global(.hero-header),
  .og-product :global(.stage-controls),
  .og-product :global(.demo-control) {
    display: none;
  }

  .og-product :global(.stage-shell),
  .og-product :global(.stage) {
    width: 100%;
    height: 630px;
    padding: 0;
  }

  .og-product :global(.stage .scene) {
    width: 39rem;
    max-width: none;
    --laptop-solo-width: 78%;
    --laptop-solo-top: 40%;
  }
</style>
