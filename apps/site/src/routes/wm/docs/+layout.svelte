<script lang="ts">
  import { page } from "$app/state";
  import { afterNavigate } from "$app/navigation";
  import { onMount, tick } from "svelte";
  import { setContext } from "svelte";
  import { commandNavigation, docsBase, guideLinks, searchEntries } from "$lib/docs/navigation.js";
  import CommandNavigation from "$lib/docs/CommandNavigation.svelte";
  import PaneformWordmark from "$lib/hero/PaneformWordmark.svelte";
  import DocsToc from "$lib/docs/DocsToc.svelte";
  import "$lib/docs/docs.css";
  import { enhanceHeadingAnchors } from "$lib/docs/heading-anchors.js";

  let { children, data } = $props();
  setContext("docs-playground", () => data.playgroundEnabled);
  let search = $state("");
  let searchOpen = $state(false);
  let navigationOpen = $state(false);
  let searchInput = $state<HTMLInputElement>();
  const results = $derived(searchEntries.filter((entry) => `${entry.title} ${entry.summary} ${entry.keywords ?? ''}`.toLowerCase().includes(search.toLowerCase())).slice(0, 12));

  onMount(() => {
    enhanceHeadingAnchors(document);
    function keydown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault(); searchOpen = true; searchInput?.focus();
      }
      if (event.key === "Escape") { searchOpen = false; searchInput?.blur(); }
    }
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); };
  });

  afterNavigate(() => {
    void tick().then(() => enhanceHeadingAnchors(document));
  });
</script>

<svelte:head><title>Docs · Paneform WM</title><meta name="description" content="Guides and code-generated command reference for Paneform WM." /></svelte:head>
<div class="docs">
  <header class="docs-topbar">
    <div class="docs-wordmark"><a href="/wm"><PaneformWordmark clipId="docs-logo" /></a><span aria-hidden="true">/</span><a href={docsBase + "/"}>docs</a></div>
    <div class="docs-spacer"></div>
    <div class="docs-search-wrap" onfocusout={(event) => { if (!(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) searchOpen = false; }}>
      <input bind:this={searchInput} bind:value={search} aria-label="Search docs" placeholder="Search docs…" onfocus={() => (searchOpen = true)} />
      <kbd>⌘K</kbd>
      {#if searchOpen}
        <div class="docs-search-results">
          {#each results as entry}
            <a href={entry.href} onclick={() => { searchOpen = false; search = ""; }}>{entry.title}<small>{entry.summary}</small></a>
          {:else}<p>No matching pages.</p>{/each}
        </div>
      {/if}
    </div>
    {#if data.playgroundEnabled}<a class="docs-play-link" href="/wm/play">Playground ↗</a>{/if}
  </header>
  <div class="docs-shell">
    <button type="button" class="docs-mobile-nav" aria-expanded={navigationOpen} onclick={() => (navigationOpen = !navigationOpen)}>{navigationOpen ? "Close navigation" : "Browse documentation"}</button>
    <nav class:open={navigationOpen} class="docs-sidebar" aria-label="Documentation">
      <div class="docs-nav-group"><p>Getting started</p><a class:active={page.url.pathname === guideLinks[0].href} href={guideLinks[0].href} onclick={() => (navigationOpen = false)}>Installation</a></div>
      <div class="docs-nav-group"><p>Concepts</p><a class:active={page.url.pathname === guideLinks[1].href} href={guideLinks[1].href} onclick={() => (navigationOpen = false)}>Workspaces and layout</a></div>
      <div class="docs-nav-group docs-command-links"><p><a href={docsBase + "/commands/"}>Commands</a></p>
        <CommandNavigation nodes={commandNavigation} currentHref={page.url.pathname + page.url.hash} onnavigate={() => (navigationOpen = false)} />
      </div>
      <div class="docs-nav-group"><p>Configuration</p><a class:active={page.url.pathname === guideLinks[2].href} href={guideLinks[2].href} onclick={() => (navigationOpen = false)}>Options</a></div>
      <div class="docs-nav-group"><p>Reference</p><a class:active={page.url.pathname === guideLinks[3].href} href={guideLinks[3].href} onclick={() => (navigationOpen = false)}>CLI listing</a></div>
    </nav>
    <main id="docs-main">{@render children()}</main>
    <DocsToc />
  </div>
</div>
