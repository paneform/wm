<script lang="ts">
  import { commandDocs } from "@paneform/layout";
  import { commandHref } from "$lib/docs/navigation.js";
  import DemoStage from "$lib/docs/DemoStage.svelte";
  import { demosForCommand } from "$lib/docs/demo-data.js";
</script>
<p class="docs-breadcrumb">Docs / Overview</p>
<h1>Make room for everything.</h1>
<p class="lede">Paneform WM gives every window a place. Learn the basics, watch a command run, then take it into the playground.</p>
<h2 id="tour">A one-minute tour</h2>
<p>Move the focused window to the left. The layout engine swaps it with its neighbor.</p>
<p>Example command: <code>wm window move left</code></p>
<DemoStage situations={demosForCommand("windows/move-directional")!} />
<h2 id="explore">Explore</h2>
<div class="related"><a href="/wm/docs/getting-started/">Get started <small>Install and verify wm</small></a><a href="/wm/docs/concepts/">Understand workspaces <small>How layout and focus work</small></a><a href="/wm/docs/commands/">Browse {commandDocs.length} commands <small>Generated from the CLI grammar</small></a><a href={commandHref("windows/move-directional")}>Move directionally <small>See it in context</small></a></div>
