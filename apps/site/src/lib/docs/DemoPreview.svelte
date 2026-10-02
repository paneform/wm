<script lang="ts">
  import { playbackSteps, type LayoutScenario, type SimulationState } from "@paneform/layout-browser";
  import { effectiveSettings } from "@paneform/layout";
  import { windowsForDisplay } from "$lib/play/projection.js";
  import { workspaceIndicators } from "./workspace-indicators.js";

  let {
    scenario,
    state,
    flash = false,
  }: {
    scenario: LayoutScenario;
    state: SimulationState;
    flash?: boolean;
  } = $props();

  const workspaces = $derived(
    [...new Set([
      ...scenario.state.topology.map((item) => item.workspace),
      ...scenario.state.windows.map((window) => window.workspace),
      playbackSteps(scenario)[0]?.expect?.focusedWorkspace,
      ...state.topology.map((item) => item.workspace),
      ...state.windows.map((window) => window.workspace),
    ].filter((name): name is string => name !== null && name !== undefined))],
  );
  const indicators = $derived(workspaceIndicators(scenario, state));
</script>

<span class="preview-displays">
{#each state.topology as display (display.id)}
  {@const focusedWorkspace = display.workspace}
  {@const margin = effectiveSettings(scenario.config ?? {}, display.workspace ?? '', display.id).margins.top ?? 0}
  {@const visibleWindows = windowsForDisplay(state, display)}
  <span class="preview-screen" data-display-id={display.id} aria-hidden="true">
    <span class="workspace-bar">
      {#each workspaces as name (name)}
        <span class="workspace-chip" class:focused={name === focusedWorkspace} data-workspace={name}>
          <span class="workspace-name">{name}</span>
          <span class="workspace-apps">
            {#each indicators.filter((item) => item.workspace === name && item.displayId === display.id) as item (item.windowId)}
              <span class="workspace-app" data-window-id={item.windowId}></span>
            {/each}
          </span>
        </span>
      {/each}
    </span>
    <span class="workarea">
      {#each visibleWindows as window (window.id)}
        <span
          class="pane"
          data-window-id={window.id}
           class:focused={window.id === state.focusedWindow}
           class:floating={window.floating}
          style:left={`${((window.frame.x - display.frame.x) / display.frame.width) * 100}%`}
          style:top={`${((window.frame.y - display.frame.y - margin) / (display.frame.height - margin)) * 100}%`}
          style:width={`${(window.frame.width / display.frame.width) * 100}%`}
          style:height={`${(window.frame.height / (display.frame.height - margin)) * 100}%`}
        ><span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span></span>
      {/each}
      <span class="flash" class:on={flash}></span>
    </span>
  </span>
{/each}
</span>

<style>
  .preview-displays { display: grid; height: var(--demo-preview-height, auto); grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: .35rem; align-items: center; justify-items: center; min-width: 0; }
  .pane.floating { border-style: dashed; }
  .preview-screen { position: relative; display: flex; width: min(100%, var(--demo-screen-width, 100%)); aspect-ratio: 16 / 10; flex-direction: column; overflow: hidden; border: 1px solid var(--docs-line); border-radius: var(--radius-small); background: var(--rp-base); }
  .workspace-bar { display: flex; height: 1.1rem; flex: none; align-items: stretch; gap: 3px; padding: 2px 4px; }
  .workspace-chip { display: flex; height: 100%; min-width: 0; align-items: center; gap: 3px; padding-right: 4px; border: 1px solid var(--rp-subtle); border-radius: 3px; color: var(--rp-subtle); font-size: 0.5625rem; line-height: 1; white-space: nowrap; }
  .workspace-chip.focused { border-color: var(--rp-gold); color: var(--rp-gold); }
  .workspace-name { display: flex; align-self: stretch; align-items: center; padding: 0 3px; border-radius: 2px 3px 3px 2px; background: var(--rp-subtle); color: var(--rp-base); font-weight: 600; }
  .workspace-chip.focused .workspace-name { background: var(--rp-gold); }
  .workspace-apps { display: flex; gap: 2px; }
  .workspace-bar :global(.workspace-app), .workspace-bar :global(.workspace-app-placeholder) { width: 5px; height: 5px; flex: none; border-radius: 1.5px; background: currentColor; opacity: 0.85; }
  .workarea { position: relative; flex: 1; background: var(--rp-surface); }
  .pane { position: absolute; border: 1px solid var(--rp-subtle); border-radius: 4px; background: var(--rp-surface); transition: left var(--demo-transition-duration, 500ms) var(--easing-standard), top var(--demo-transition-duration, 500ms) var(--easing-standard), width var(--demo-transition-duration, 500ms) var(--easing-standard), height var(--demo-transition-duration, 500ms) var(--easing-standard); }
  .pane.focused { border: 2px solid var(--rp-iris); background: var(--rp-overlay); }
  .dot { position: absolute; top: 5px; width: 4.5px; height: 4.5px; border-radius: 50%; }
  .dot.red { left: 5px; background: var(--rp-love); }
  .dot.yellow { left: 13px; background: var(--rp-gold); }
  .dot.green { left: 21px; background: var(--rp-pine); }
  .pane:not(.focused) .dot { background: var(--rp-subtle); }
  .flash { position: absolute; inset: 0; background: color-mix(in srgb, var(--rp-love) 7%, transparent); opacity: 0; pointer-events: none; transition: opacity var(--demo-flash-duration, 250ms); }
  .flash.on { opacity: 1; }
  @media (prefers-reduced-motion: reduce) { .pane { transition: none; } }
</style>
