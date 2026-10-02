<script lang="ts">
  import { commandNavigation } from "$lib/docs/navigation.js";
  import CommandNavigation from "$lib/docs/CommandNavigation.svelte";
</script>
<p class="docs-breadcrumb">Docs / Commands</p><h1>Commands</h1>
<p class="lede">This listing is generated from the layout package’s command grammar. Each form links to its reference page.</p>
{#each commandNavigation as node}
  <h2 id={node.token}>{#if node.href}<a href={node.href}>{node.label}</a>{:else}{node.label}{/if}</h2>
  {#if node.children.length}<CommandNavigation nodes={node.children} showSyntax />{:else if node.syntax}<p><code>{node.syntax}</code></p>{/if}
{/each}
