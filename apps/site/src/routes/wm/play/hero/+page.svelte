<script lang="ts">
  import ScenarioPlayer from "$lib/play/ScenarioPlayer.svelte";
  import { parseHeroScenario } from "$lib/play/hero-scenario.js";

  const scenario = parseHeroScenario();
</script>

<svelte:head>
  <title>Every pane tells a story | Paneform WM</title>
  <meta name="description" content="Play the Paneform hero as an editable, shareable window manager scenario." />
  <link rel="canonical" href="https://paneform.com/wm/play/hero" />
  <link rel="alternate" type="application/schema+json" href="/wm/play/scenario.schema.json" title="Paneform scenario JSON Schema" />
</svelte:head>

<nav aria-label="Breadcrumb"><a href="../">&larr; Playground</a><a href="/wm/">Paneform WM</a></nav>
<main><ScenarioPlayer initialScenario={scenario} title="Every pane tells a story." description="From a pile of windows to a little more focus. Play the demo, inspect its steps, or make it your own." /></main>

<style>
  nav { display: flex; justify-content: space-between; gap: 1rem; width: min(100% - 2 * var(--page-gutter), 82rem); margin: 0 auto; padding-top: 1.25rem; }
  nav a { color: var(--color-page-secondary); font-size: var(--type-size-control); text-underline-offset: 0.3em; }
  nav a:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 4px; }
</style>
