<script lang="ts">
  import ScenarioPlayer from "$lib/play/ScenarioPlayer.svelte";
  import { emptyPlaygroundScenario } from "$lib/play/playground-defaults.js";
</script>

<svelte:head>
  <title>Window manager playground | Paneform WM</title>
  <meta name="description" content="Run, edit, and share a portable Paneform window layout scenario in your browser." />
  <link rel="canonical" href="https://paneform.com/wm/play" />
  <link rel="alternate" type="application/schema+json" href="./scenario.schema.json" title="Paneform scenario JSON Schema" />
</svelte:head>

<nav aria-label="Breadcrumb"><a href="../">&larr; Paneform WM</a><a href="./hero/">Play the hero demo &rarr;</a></nav>
<main><ScenarioPlayer initialScenario={emptyPlaygroundScenario} title="Your desktop. Your rules." description="Open a few apps, start Paneform, and see your workspace take form. Everything here stays in the sandbox." /></main>

<style>
  nav { display: flex; justify-content: space-between; gap: 1rem; flex-wrap: wrap; width: min(100% - 2 * var(--page-gutter), 82rem); margin: 0 auto; padding-top: 1.25rem; }
  nav a { color: var(--color-page-secondary); font-size: var(--type-size-control); text-decoration-thickness: 1px; text-underline-offset: 0.3em; }
  nav a:focus-visible { outline: 2px solid var(--color-focus-ring); outline-offset: 4px; }
</style>
