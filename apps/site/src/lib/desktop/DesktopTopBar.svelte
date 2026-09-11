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
  .workspace-bar { position: absolute; z-index: var(--layer-controls); inset: 0 0 auto; display: flex; align-items: stretch; gap: clamp(0.06rem, 0.16vw, 0.16rem); width: 100%; height: var(--camera-height); overflow: hidden; padding: clamp(0.04rem, 0.1vw, 0.1rem); padding-inline-start: var(--radius-laptop-screen); background: color-mix(in srgb, var(--rp-base) 31%, transparent); font-family: var(--type-family-product); }
  .workspace-bar.notched { inset-inline-end: auto; width: calc(50% - var(--camera-width) / 2 - var(--camera-join-size)); }
  button { --workspace-color: var(--rp-subtle); display: flex; min-width: 0; align-items: center; gap: clamp(0.08rem, 0.25vw, 0.25rem); overflow: hidden; border: var(--stroke-hairline) solid var(--workspace-color); border-radius: clamp(0.08rem, 0.25vw, 0.25rem); padding: 0 clamp(0.12rem, 0.3vw, 0.3rem) 0 0; background: color-mix(in srgb, var(--rp-surface) 38%, transparent); color: var(--workspace-color); font: inherit; font-size: clamp(0.2rem, 0.62vw, 0.58rem); line-height: 1; white-space: nowrap; transition: border-color var(--motion-feedback) var(--easing-standard), background var(--motion-feedback) var(--easing-standard), color var(--motion-feedback) var(--easing-standard); }
  button:not(:disabled) { cursor: pointer; } button:not(:disabled):hover,button.focused { --workspace-color: var(--rp-gold); } button:focus-visible { outline: var(--stroke-strong) solid var(--color-focus-ring); outline-offset: calc(-1 * var(--stroke-strong)); }
  strong { display: grid; align-self: stretch; min-width: 1.55em; flex: none; place-items: center; border-radius: clamp(0.07rem, 0.2vw, 0.2rem); background: var(--workspace-color); color: var(--rp-base); }
  .window-icons { display: flex; min-width: 0; gap: clamp(0.04rem, 0.14vw, 0.14rem); } .window-icon { width: clamp(0.24rem, 0.72vw, 0.64rem); aspect-ratio: 1; }
</style>
