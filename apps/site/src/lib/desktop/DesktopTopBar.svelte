<script lang="ts">
  import DockIcon from "./DockIcon.svelte";
  import type { AppIcon } from "./desktop-model.js";
  let { workspaces, focusedWorkspace, interactive = false, onfocusworkspace, notched = true }: { workspaces: readonly { name: string; apps: readonly { title: string; icon?: AppIcon }[] }[]; focusedWorkspace: string | null; interactive?: boolean; onfocusworkspace?: (name: string) => void; notched?: boolean; } = $props();
</script>
<nav class="workspace-bar" class:notched aria-label="Workspaces">
  {#each workspaces as workspace (workspace.name)}
    <button class:focused={focusedWorkspace === workspace.name} disabled={!interactive} aria-current={focusedWorkspace === workspace.name ? "true" : undefined} aria-label={`Focus workspace ${workspace.name}: ${workspace.apps.map(({ title }) => title).join(", ")}`} onclick={() => onfocusworkspace?.(workspace.name)}><strong>{workspace.name}</strong><span class="window-icons" aria-hidden="true">{#each workspace.apps as app}<span class="window-icon"><DockIcon icon={app.icon} /></span>{/each}</span></button>
  {/each}
</nav>
<style>
  .workspace-bar { position: absolute; z-index: var(--layer-controls); inset: 0 0 auto; display: flex; align-items: stretch; gap: 0.3cqw; width: 100%; height: var(--camera-height); container-type: size; overflow: hidden; padding: 0.15cqh; padding-inline-start: var(--radius-laptop-screen); background: color-mix(in srgb, var(--rp-base) 31%, transparent); font-family: var(--type-family-product); }
  .workspace-bar.notched { padding-inline-end: calc(50% + var(--camera-width) / 2 + var(--camera-join-size)); }
  /* Controls use the bar's content height, independent of the browser viewport. */
  /* An inset outline lets the label share the outer clip instead of leaving a border seam during scaling. */
  button { --workspace-color: var(--rp-subtle); --workspace-item-height: max(0px, calc(100cqh - 2 * var(--stroke-hairline))); display: flex; min-width: 0; align-items: center; gap: min(0.25rem, 12cqh); overflow: hidden; border: 0; box-shadow: inset 0 0 0 var(--stroke-hairline) var(--workspace-color); border-radius: min(0.25rem, 16cqh); padding: var(--stroke-hairline) calc(min(0.3rem, 15cqh) + var(--stroke-hairline)) var(--stroke-hairline) var(--stroke-hairline); background: color-mix(in srgb, var(--rp-surface) 38%, transparent); color: var(--workspace-color); font: inherit; font-size: min(0.8rem, calc(var(--workspace-item-height) * 0.86)); line-height: 1; white-space: nowrap; transition: box-shadow var(--motion-feedback) var(--easing-standard), background var(--motion-feedback) var(--easing-standard), color var(--motion-feedback) var(--easing-standard); }
  button:not(:disabled) { cursor: pointer; } button:not(:disabled):hover,button.focused { --workspace-color: var(--rp-gold); } button:focus-visible { outline: var(--stroke-strong) solid var(--color-focus-ring); outline-offset: calc(-1 * var(--stroke-strong)); }
  strong { display: grid; align-self: stretch; min-width: 1.55em; flex: none; place-items: center; margin: calc(-1 * var(--stroke-hairline)) 0 calc(-1 * var(--stroke-hairline)) calc(-1 * var(--stroke-hairline)); border-radius: 0 min(0.2rem, 14cqh) min(0.2rem, 14cqh) 0; background: var(--workspace-color); color: var(--rp-base); }
  .window-icons { display: flex; min-width: 0; gap: min(0.14rem, 10cqh); }
  /* Safari can retain an SVG's old intrinsic height when only its width changes. */
  .window-icon { --workspace-icon-size: min(0.875rem, var(--workspace-item-height)); flex: none; width: var(--workspace-icon-size); height: var(--workspace-icon-size); aspect-ratio: 1; }
</style>
