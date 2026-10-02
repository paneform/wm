<script lang="ts">
  import { isCommandNavActive, type CommandNavNode } from "./navigation.js";
  let { nodes, currentHref = "", showSyntax = false, onnavigate }: {
    nodes: readonly CommandNavNode[];
    currentHref?: string;
    showSyntax?: boolean;
    onnavigate?: () => void;
  } = $props();
</script>

{#snippet tree(items: readonly CommandNavNode[])}
  <ul class="command-tree" class:with-syntax={showSyntax}>
    {#each items as node (node.token)}
      <li>
        {#if node.href}
          <a href={node.href} class:active={isCommandNavActive(node, currentHref)} aria-current={isCommandNavActive(node, currentHref) ? node.href.includes('#') ? 'location' : 'page' : undefined} onclick={onnavigate}>
            {node.label}{#if showSyntax && node.syntax}<small>{node.syntax}</small>{/if}
          </a>
        {:else}<span class="branch">{node.label}</span>{/if}
        {#if node.children.length}{@render tree(node.children)}{/if}
      </li>
    {/each}
  </ul>
{/snippet}
{@render tree(nodes)}

<style>
  .command-tree { list-style: none; margin: 0; padding: 0; }
  .command-tree .command-tree { margin-left: .65rem; padding-left: .65rem; border-left: 1px solid var(--docs-line); }
  li { margin: .15rem 0; }
  a, .branch { display: block; padding: .22rem .45rem; border-radius: var(--radius-small); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--docs-xs); }
  a { text-decoration: none; color: var(--color-page-secondary); }
  .branch { color: var(--docs-label); font-weight: 600; }
  a:hover, a.active { background: color-mix(in srgb, var(--rp-overlay) 75%, transparent); color: var(--rp-text); }
  a.active { font-weight: 650; }
  .with-syntax a, .with-syntax .branch { font-size: var(--docs-sm); }
  small { display: block; color: var(--docs-quiet); font-size: var(--docs-xs); overflow-wrap: anywhere; }
</style>
