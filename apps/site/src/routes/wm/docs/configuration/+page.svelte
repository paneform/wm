<script lang="ts">
  import { ConfigSchema } from "@paneform/layout";
  import { JSONSchema } from "effect";
  const schema = JSONSchema.make(ConfigSchema);
  const fields = Object.entries("properties" in schema ? schema.properties ?? {} : {});
</script>
<p class="docs-breadcrumb">Docs / Configuration / Options</p>
<h1>Configuration</h1><p class="lede">The accepted fields and their structure come from the layout package’s strict configuration schema. Unknown fields are rejected.</p>
<h2 id="fields">Top-level fields</h2>
<table><tbody><tr><th>Field</th><th>Shape</th></tr>
  {#each fields as [key, field]}
    <tr><td data-label="Field"><code>{key}</code></td><td data-label="Shape"><code>{JSON.stringify(field)}</code></td></tr>
  {/each}
</tbody></table>
<h2 id="validate">Validate changes</h2><p>Use <code>wm validate-config</code> to check the active config. Window-manager defaults can be overridden per display and per workspace.</p>
