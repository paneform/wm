<script lang="ts">
  import { ConfigSchema } from "@paneform/layout";
  import { JSONSchema } from "effect";
  const schema = JSONSchema.make(ConfigSchema);
  const fields = Object.entries("properties" in schema ? schema.properties ?? {} : {});
</script>
<p class="docs-breadcrumb">Docs / Configuration / Options</p>
<h1>Configuration</h1><p class="lede">The accepted fields and their structure come from the layout package’s strict configuration schema. Unknown fields are rejected.</p>
<h2 id="fields">Top-level fields</h2>
{#each fields as [key, field]}
  <h3 id={`field-${key}`}>{key}</h3>
  <pre><code>{JSON.stringify(field, null, 2)}</code></pre>
{/each}
<h2 id="validate">Validate changes</h2><p>Use <code>wm config validate</code> to check the active config. Window-manager defaults can be overridden per display and per workspace.</p>
