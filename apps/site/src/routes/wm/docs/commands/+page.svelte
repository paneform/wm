<script lang="ts">
  import { commandDocs } from "@paneform/layout";
  import { commandGroups, commandHref } from "$lib/docs/navigation.js";
</script>
<p class="docs-breadcrumb">Docs / Commands</p><h1>Commands</h1>
<p class="lede">This listing is generated from the layout package’s command grammar. Each form links to its reference page.</p>
{#each commandGroups as group}
  <h2 id={group}>{group}</h2>
  <div class="related">{#each commandDocs.filter((doc) => doc.domain === group) as doc}<a href={commandHref(doc.slug)}>{doc.title}<small>{doc.forms[0]?.syntax}</small></a>{/each}</div>
{/each}
<h2 id="diagnostics">Diagnostics</h2><div class="related"><a href="/wm/docs/commands/diagnostics/doctor/">wm doctor<small>Check local permissions</small></a></div>
