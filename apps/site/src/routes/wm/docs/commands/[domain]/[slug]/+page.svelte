<script lang="ts">
  import { commandDocs } from "@paneform/layout";
  import { playbackSteps } from "@paneform/layout-browser";
  import DemoStage from "$lib/docs/DemoStage.svelte";
  import WindowObservationDetails from "$lib/docs/WindowObservationDetails.svelte";
  import { demoDefinitions, demosForCommand } from "$lib/docs/demo-data.js";
  import { payloadTooltips } from "$lib/docs/payload-tooltip.js";
  import { commandHref, commandBreadcrumbs } from "$lib/docs/navigation.js";
  import { argumentRows, invocationRows } from "$lib/docs/invocations.js";
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
  const argumentsList = $derived(argumentRows(doc));
</script>
<svelte:head><title>{doc.title} · Paneform WM docs</title><meta name="description" content={doc.summary} /></svelte:head>
<p class="docs-breadcrumb">Docs / Commands / {commandBreadcrumbs(doc).join(' / ')}</p>
<h1>{doc.title}</h1><p class="lede">{doc.summary}</p>
{#if demos}
  <p class="demo-examples">Example {examples.length === 1 ? 'command' : 'commands'}: {#each examples as command, index}{#if index > 0} · {/if}<code>wm {command}</code>{/each}</p>
  {#key doc.slug}<DemoStage situations={demos} />{/key}
{:else}
  {#each exceptions as reason}<p class="lede">{reason}</p>{/each}
{/if}
<h2 id="invocation">Invocation</h2>
<table use:payloadTooltips><tbody><tr><th>Method</th><th>Invocation</th></tr>
  {#each invocations as row}<tr><td data-label="Method"><span class="method" class:ws={row.method === 'WebSocket'} class:key={row.method === 'Keybind'} class:scenario={row.method === 'Scenario'}>{row.method}</span></td><td data-label="Invocation">{#if row.method === 'WebSocket' && row.fields !== undefined && row.fields.length > 0}<pre class="websocket-payload"><code>{'{'}{#each row.fields as field, index}{'\n'}{'  '}<span class="payload-line" class:required={field.required} class:optional={!field.required} data-tip={field.summary}><span class="payload-key">"{field.name}"</span>{': '}{field.value}{index < row.fields.length - 1 ? ',' : ''}</span>{/each}{'\n'}{'}'}</code></pre>{:else}<code>{row.syntax}</code>{/if}{#if row.note}<small>{row.note}</small>{/if}</td></tr>{/each}
</tbody></table>
{#if invocations.some((row) => row.fields !== undefined && row.fields.length > 0)}
  <p class="payload-legend">Payload fields: <span class="required">required</span> · <span class="optional">optional</span> — hover a line for details.</p>
{/if}
{#if doc.slug === 'windows/observe'}
  <p class="note">CLI output includes live facts, cached comparison, and available platform diagnostics by default. Add <code>--verbose</code> to retain the transport envelope.</p>
{:else}
  <p class="note">CLI output shows useful summary fields by default. Add <code>--verbose</code> for the full response and diagnostic details. WebSocket results retain their full structured data.</p>
{/if}
<h2 id="arguments">Arguments</h2>
{#if argumentsList.length > 0}
  <table><tbody><tr><th>Text (CLI · scenario · keybind)</th><th>WebSocket</th><th>Status</th><th>Description</th></tr>
    {#each argumentsList as argument}<tr><td data-label="Text">{#if argument.text !== null}<code>{argument.text}</code>{:else}<span class="argument-none">—</span>{/if}</td><td data-label="WebSocket"><code>{argument.wire}</code></td><td data-label="Status"><span class="option-chip" class:required={argument.required} class:optional={!argument.required}>{argument.required ? 'required' : 'optional'}</span></td><td data-label="Description">{argument.description}</td></tr>{/each}
  </tbody></table>
{:else}<p>This command has no arguments.</p>{/if}
{#if doc.slug === 'windows/observe'}<WindowObservationDetails />{/if}
{#if doc.errors.length}
  <h2 id="errors">Errors</h2>
  <table><tbody><tr><th>Code</th><th>Meaning</th><th>What to do</th></tr>
    {#each doc.errors as issue}<tr><td data-label="Code"><code>{issue.code}</code></td><td data-label="Meaning">{issue.meaning}</td><td data-label="What to do">{issue.action}</td></tr>{/each}
  </tbody></table>
{/if}
<h2 id="related">Related</h2>
<div class="related">{#each related as item}<a href={commandHref(item.slug)}>{item.title}<small>{item.forms[0]?.syntax}</small></a>{/each}<a href="/wm/docs/reference/cli/">CLI listing<small>All forms in one place</small></a></div>
