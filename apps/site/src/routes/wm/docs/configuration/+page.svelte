<script lang="ts">
  import { GLOBAL_DEFAULT_SETTINGS } from "@paneform/layout";
  import { configFieldDocs } from "$lib/docs/config-examples.js";

  const { name, preferredDisplay, assign, ...effectiveDefaults } = GLOBAL_DEFAULT_SETTINGS;
</script>
<p class="docs-breadcrumb">Docs / Configuration / Options</p>
<h1>Configuration</h1><p class="lede">The daemon reads a strict JSONC configuration. Unknown fields are rejected. Overrides compose field-by-field: workspace over display over global defaults.</p>
{#each configFieldDocs as field}
  <h2 id={`field-${field.key}`}>{field.key}</h2>
  <p>{field.summary}</p>
  <pre><code>{JSON.stringify(field.example, null, 2)}</code></pre>
  {#if field.notes.length > 0}<ul>{#each field.notes as note}<li>{note}</li>{/each}</ul>{/if}
{/each}
<h2 id="effective-defaults">Effective defaults</h2>
<p>With no configuration at all, every workspace uses these settings:</p>
<pre><code>{JSON.stringify(effectiveDefaults, null, 2)}</code></pre>
<h2 id="validate">Validate changes</h2><p>Use <code>wm config validate</code> to check the active config. Window-manager defaults can be overridden per display and per workspace.</p>
