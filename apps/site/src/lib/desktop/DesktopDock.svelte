<script lang="ts">
  import DockIcon from "./DockIcon.svelte";
  import { measureDock, type DockMetrics } from "./dock-layout.js";
  import type { DockItem, Frame } from "./desktop-model.js";

  let { items, interactive = false, cursorApp = null, hoveredApp = null, onactivate, frame, workArea, onworkareachange }: {
    items: readonly DockItem[];
    interactive?: boolean;
    cursorApp?: string | null;
    hoveredApp?: string | null;
    onactivate?: (id: string) => void;
    frame?: Frame;
    workArea?: Frame;
    onworkareachange?: ((area: Frame) => void) | undefined;
  } = $props();
  const instanceId = $props.id();
  let dock = $state<HTMLElement>();
  let metrics = $state<DockMetrics | null>(null);

  $effect(() => {
    if (onworkareachange || !frame || !workArea || !dock) { metrics = null; return; }
    const parent = dock.parentElement;
    if (!parent) return;
    const update = () => { metrics = measureDock(frame, workArea, parent.clientWidth, parent.clientHeight, items.length); };
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    update();
    return () => observer.disconnect();
  });

  $effect(() => {
    if (!dock || !frame || !workArea || !onworkareachange) return;
    const element = dock;
    const parent = element.parentElement;
    if (!parent) return;
    const displayFrame = frame;
    const baseArea = workArea;
    const notify = onworkareachange;
    let lastHeight = -1;
    let pending = 0;
    const update = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(() => {
        const parentStyle = getComputedStyle(parent);
        const parentHeight = parseFloat(parentStyle.height) + (parentStyle.boxSizing === "border-box"
          ? -parseFloat(parentStyle.borderTopWidth) - parseFloat(parentStyle.borderBottomWidth)
          : parseFloat(parentStyle.paddingTop) + parseFloat(parentStyle.paddingBottom));
        // Resolved CSS positions preserve subpixels and ignore the laptop's 3D tilt.
        // `top` locates the dock's outer margin edge within the parent's padding box.
        // offsetTop/clientHeight round independently and can let the borders overlap.
        const top = parseFloat(getComputedStyle(element).top);
        if (!Number.isFinite(top) || !Number.isFinite(parentHeight) || parentHeight <= 0) return;
        const bottom = displayFrame.y + top / parentHeight * displayFrame.height;
        const height = Math.max(0, Math.floor(bottom - baseArea.y));
        if (height === lastHeight) return;
        lastHeight = height;
        notify({ ...baseArea, height });
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    observer.observe(element);
    window.addEventListener("resize", update);
    update();
    return () => { observer.disconnect(); window.removeEventListener("resize", update); cancelAnimationFrame(pending); };
  });
</script>

<div bind:this={dock} class="dock screen-dock" class:measured={metrics} role="group" aria-label="Desktop dock" style:--measured-dock-icon-size={`${metrics?.iconSize ?? 22}px`} style:--measured-dock-gap={`${metrics?.gap ?? 2}px`} style:--measured-dock-padding={`${metrics?.padding ?? 2}px`} style:--measured-dock-bottom={`${metrics?.bottom ?? 2}px`} style:--measured-dock-indicator-offset={`${metrics?.indicatorOffset ?? 2}px`} style:--measured-dock-border={`${metrics?.border ?? 1}px`}>
  {#each items as item (item.id)}
    {@const tooltipId = `${instanceId}-dock-tooltip-${item.id}`}
    <button type="button" data-app={item.id} aria-label={`${item.open ? "Focus" : "Open"} ${item.title}`} aria-describedby={tooltipId} aria-disabled={!interactive} disabled={!interactive} tabindex={interactive ? undefined : -1} class:paneform-icon-button={item.icon === "paneform"} class:hovered={hoveredApp === item.id || cursorApp === item.id} onclick={(event) => { event.stopPropagation(); if (interactive) onactivate?.(item.id); }}>
      <span class="dock-icon"><DockIcon icon={item.icon} /></span>
      <span class="dock-tooltip" id={tooltipId} role="tooltip">{item.icon === "paneform" ? "paneform wm" : item.title}</span>
      {#if cursorApp === item.id}<span class="dock-cursor" aria-hidden="true"></span>{/if}
      <i class:open={item.open}></i>
    </button>
  {/each}
</div>

<style>
  /* Equal grid tracks shrink square icons together instead of squeezing only their widths. */
  .dock { --dock-icon-background: color-mix(in srgb, var(--color-surface-raised) var(--opacity-88), transparent); display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); align-items: center; justify-content: center; gap: var(--dock-gap); }
  .dock.screen-dock.measured { --dock-icon-size: var(--measured-dock-icon-size); --dock-gap: var(--measured-dock-gap); --dock-padding: var(--measured-dock-padding); --dock-screen-bottom: var(--measured-dock-bottom); --dock-indicator-offset: var(--measured-dock-indicator-offset); border-width: var(--measured-dock-border); }
  .screen-dock { position: absolute; z-index: var(--layer-screen-dock); inset: auto 50% calc(var(--dock-screen-bottom) / 2) auto; width: max-content; max-width: 100%; transform: translateX(50%); backface-visibility: hidden; will-change: transform; padding: var(--dock-padding); border: var(--stroke-hairline) solid var(--color-line-default); border-radius: var(--radius-control); background: var(--color-window-background); pointer-events: auto; }
  button { position: relative; display: grid; width: var(--dock-icon-size); max-width: 100%; min-width: 0; min-height: 0; aspect-ratio: 1; place-items: center; border: 0; border-radius: 21.875%; padding: 0; background: var(--dock-icon-background); box-shadow: inset 0 var(--stroke-hairline) var(--space-1) color-mix(in srgb, var(--color-page-foreground) 8%, transparent), 0 var(--stroke-hairline) var(--space-2) color-mix(in srgb, var(--rp-base) 24%, transparent); color: var(--color-page-foreground); transition: background var(--motion-feedback) var(--easing-standard), box-shadow var(--motion-feedback) var(--easing-standard), transform var(--motion-feedback) var(--easing-standard); }
  .dock-icon { display: block; width: min(100%, var(--dock-glyph-size)); aspect-ratio: 1; pointer-events: none; }
  .paneform-icon-button .dock-icon { width: 100%; }
  .dock-icon :global(svg), .dock-icon :global(svg *) { pointer-events: none; }
  button:not(:disabled) { cursor: pointer; } button:disabled { cursor: default; }
  button:not(:disabled):active { background: color-mix(in srgb, var(--color-surface-base) 68%, var(--rp-base)); box-shadow: inset 0 var(--stroke-strong) var(--space-1) color-mix(in srgb, var(--rp-base) 48%, transparent), 0 var(--stroke-hairline) var(--space-2) color-mix(in srgb, var(--rp-base) 24%, transparent); transform: translateY(var(--stroke-hairline)); }
  button:focus-visible { outline: var(--stroke-strong) solid var(--color-focus-ring); outline-offset: var(--stroke-hairline); }
  button i { position: absolute; inset: calc(100% + var(--dock-padding) / 2) auto auto 50%; width: calc(var(--stroke-strong) * 1.5); aspect-ratio: 1; border-radius: 50%; background: transparent; transform: translate(-50%, -50%); pointer-events: none; } button i.open { background: var(--color-page-secondary); opacity: 0.9; }
  .dock-tooltip { position: absolute; z-index: 2; inset: auto auto calc(100% + var(--space-2)) 50%; width: max-content; padding: 0.2rem 0.45rem; border: var(--stroke-hairline) solid var(--color-line-default); border-radius: 999px; background: color-mix(in srgb, var(--color-surface-base) 94%, transparent); box-shadow: 0 var(--space-1) var(--space-2) color-mix(in srgb, var(--rp-base) 24%, transparent); color: var(--color-page-foreground); font: var(--type-weight-medium) min(0.6875rem, 1.6cqw)/1 var(--type-family-system); letter-spacing: 0; opacity: 0; pointer-events: none; transform: translate(-50%, var(--space-1)); transition: opacity var(--motion-feedback) var(--easing-standard), transform var(--motion-feedback) var(--easing-standard); }
  button:hover .dock-tooltip, button:focus-visible .dock-tooltip, button.hovered .dock-tooltip { opacity: 1; transform: translate(-50%, 0); }
  .dock-cursor { position: absolute; z-index: 3; inset: 34% auto auto 38%; width: min(58%, var(--cursor-size)); aspect-ratio: 1; border: var(--stroke-hairline) solid var(--color-page-background); background: var(--color-window-focus); clip-path: polygon(0 0, 80% 68%, 50% 73%, 37% 100%); pointer-events: none; animation: dock-cursor-click var(--motion-cursor-slot) var(--easing-standard) both; }
  @keyframes dock-cursor-click { 0% { opacity: 0; transform: translate(-80%, -80%) rotate(-18deg) scale(0.82); } 35%, 62% { opacity: 1; transform: translate(0) rotate(-18deg) scale(1); } 48% { opacity: 1; transform: translate(0) rotate(-18deg) scale(0.86); } 100% { opacity: 0; transform: translate(0) rotate(-18deg) scale(1); } }
</style>
