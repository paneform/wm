<script lang="ts">
  import { commandDocs } from "@paneform/layout";
  import { playbackSteps } from "@paneform/layout-browser";
  import DemoStage from "$lib/docs/DemoStage.svelte";
  import { demoDefinitions, demosForCommand } from "$lib/docs/demo-data.js";
  import { commandHref } from "$lib/docs/navigation.js";
  import { invocationRows } from "$lib/docs/invocations.js";
  let { data } = $props();
  const doc = $derived(data.doc);
  const related = $derived(commandDocs.filter((item) => item.domain === doc.domain && item.slug !== doc.slug).slice(0, 3));
  const demos = $derived(demosForCommand(doc.slug));
  const exceptions = $derived(demoDefinitions(doc).flatMap((definition) => definition.kind === 'unavailable' ? [definition.reason] : []));
  const examples = $derived([...new Set(demos?.flatMap((demo) => {
    const step = playbackSteps(demo.scenario)[0];
    return step && 'command' in step ? [step.command] : [];
  }) ?? [])]);
  const invocations = $derived(invocationRows(doc));
</script>
<svelte:head><title>{doc.title} · Paneform WM docs</title><meta name="description" content={doc.summary} /></svelte:head>
<p class="docs-breadcrumb">Docs / Commands / {doc.domain} / {doc.title}</p>
<h1>{doc.title}</h1><p class="lede">{doc.summary}</p>
{#if demos}
  <p class="demo-examples">Example {examples.length === 1 ? 'command' : 'commands'}: {#each examples as command, index}{#if index > 0} · {/if}<code>wm {command}</code>{/each}</p>
  {#key doc.slug}<DemoStage situations={demos} />{/key}
{:else}
  {#each exceptions as reason}<p class="lede">{reason}</p>{/each}
{/if}
<h2 id="invocation">Invocation</h2>
<table><tbody><tr><th>Method</th><th>Invocation</th></tr>
  {#each invocations as row}<tr><td data-label="Method"><span class="method" class:ws={row.method === 'WebSocket'} class:key={row.method === 'Keybind'} class:scenario={row.method === 'Scenario'}>{row.method}</span></td><td data-label="Invocation">{#if row.method === 'WebSocket'}<pre class="websocket-payload"><code>{row.syntax}</code></pre>{:else}<code>{row.syntax}</code>{/if}{#if row.note}<small>{row.note}</small>{/if}</td></tr>{/each}
</tbody></table>
<h2 id="arguments">Arguments</h2>
{#if doc.forms.some((form) => form.syntax.includes('<')) || doc.slug.endsWith('-directional')}
  <table><tbody><tr><th>Name</th><th>Usage</th></tr>
    {#each [...new Set(doc.forms.flatMap((form) => [...form.syntax.matchAll(/<([^>]+)>/g)].map((match) => match[1]!)).concat(doc.slug.endsWith('-directional') ? ['direction'] : []))] as slot}
      <tr><td data-label="Name"><code>{slot}</code></td><td data-label="Usage">{slot === 'workspace' ? 'A workspace name. Quote names containing spaces.' : slot === 'window' ? 'A current window ID from wm window list.' : slot === 'display' ? 'A connected display ID from wm display list.' : slot === 'direction' ? 'left, right, up, down' : 'A value in display-coordinate units.'}</td></tr>
    {/each}
  </tbody></table>
{:else}<p>This command has no arguments.</p>{/if}
{#if doc.errors.length}
  <h2 id="errors">Errors</h2>
  <table><tbody><tr><th>Code</th><th>Meaning</th><th>What to do</th></tr>
    {#each doc.errors as issue}<tr><td data-label="Code"><code>{issue.code}</code></td><td data-label="Meaning">{issue.meaning}</td><td data-label="What to do">{issue.action}</td></tr>{/each}
  </tbody></table>
{/if}
<h2 id="related">Related</h2>
<div class="related">{#each related as item}<a href={commandHref(item.slug)}>{item.title}<small>{item.forms[0]?.syntax}</small></a>{/each}<a href="/wm/docs/reference/cli/">CLI listing<small>All forms in one place</small></a></div>
