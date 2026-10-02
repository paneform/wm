<script lang="ts">
  import { GLOBAL_DEFAULT_SETTINGS } from "@paneform/layout";
  import { configFieldDocs } from "$lib/docs/config-examples.js";
  import { configReference, flattenReference } from "$lib/docs/config-reference.js";

  const { name, preferredDisplay, assign, ...effectiveDefaults } = GLOBAL_DEFAULT_SETTINGS;

  const POINTS_TIP = "macOS logical units: 1pt = 1px on standard-density displays, 2px on Retina";

  const sections = configFieldDocs.map((field) => ({
    field,
    reference: configReference.find((entry) => entry.key === field.key)!,
  }));
</script>
<p class="docs-breadcrumb">Docs / Configuration / Options</p>
<h1>Configuration</h1><p class="lede">The daemon reads a strict JSONC configuration. Unknown fields are rejected. Overrides compose field-by-field: workspace over display over global defaults.</p>
{#each sections as { field, reference }}
  <h2 id={`field-${field.key}`}>{field.key}</h2>
  <p>{field.summary}</p>
  <pre><code>{JSON.stringify(field.example, null, 2)}</code></pre>
  {#if field.table !== undefined}
    <table><tbody><tr><th>{field.table.headers[0]}</th><th>{field.table.headers[1]}</th></tr>
      {#each field.table.rows as [label, value]}
        <tr><td data-label={field.table!.headers[0]}><code>{label}</code></td><td data-label={field.table!.headers[1]}>{value}</td></tr>
      {/each}
    </tbody></table>
  {/if}
  {#if field.notes.length > 0}<ul>{#each field.notes as note}<li>{note}</li>{/each}</ul>{/if}
  <div class="docs-config-reference">
    {#each flattenReference(reference) as row}
      <div class="docs-config-field" style={`padding-left: ${row.depth * 1.25}rem`}>
        <p class="docs-config-head">
          <code>{row.key}</code>
          <span class="docs-config-badge" data-required={row.required}>{row.required ? "required" : "optional"}</span>
          <span class="docs-config-type"
            >{row.typeText}{#if row.unit !== undefined}
              <span class="docs-unit" title={POINTS_TIP}>{row.unit}</span>{/if}</span
          >
        </p>
        <p class="docs-config-desc">{row.description}</p>
      </div>
    {/each}
  </div>
{/each}
<h2 id="effective-defaults">Effective defaults</h2>
<p>With no configuration at all, every workspace uses these settings:</p>
<pre><code>{JSON.stringify(effectiveDefaults, null, 2)}</code></pre>
<h2 id="validate">Validate changes</h2><p>Use <code>wm config validate</code> to check the active config. Window-manager defaults can be overridden per display and per workspace.</p>
