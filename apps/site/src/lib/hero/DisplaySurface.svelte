<script lang="ts">
  import type { SimulationState } from "@paneform/layout-browser";

  import SettingsShortcuts from "./SettingsShortcuts.svelte";
  import WindowSurface from "../desktop/WindowSurface.svelte";
  import type { Frame } from "../desktop/desktop-model.js";
  import { windowsForDisplay } from "../play/projection.js";
  import { generatedHeroState } from "./generated-hero-state.js";
  import { MACBOOK_DISPLAY_ID } from "./hero-model.js";

  let { state, displayId, interactive = false, onclosewindow, onfocuswindow, onmovewindow, onresizewindow }: { state: SimulationState | null; displayId: string; interactive?: boolean; onresizewindow?: ((windowId: string, frame: Frame) => Promise<void> | void) | undefined; onclosewindow?: ((windowId: string) => void) | undefined; onfocuswindow?: ((windowId: string) => void) | undefined; onmovewindow?: ((windowId: string, point: Pick<Frame, "x" | "y">) => Promise<void> | void) | undefined; } = $props();
  const effective = $derived(state ?? generatedHeroState);
  const display = $derived(effective.topology.find(({ id }) => id === displayId));
  const viewport = $derived.by((): Frame | null => { if (!display) return null; return display.id === MACBOOK_DISPLAY_ID ? display.frame : display.workArea ?? display.frame; });
  const windows = $derived(display ? windowsForDisplay(effective, display).map(({ id, title, frame }) => ({ id, title: title ?? id, frame })) : []);
  const focusedWindowId = $derived(effective.focusedWindow ?? null);
  const bundleByWindowId = $derived(new Map(effective.windows.map((window) => [window.id, window.bundleId])));
  function contentFor(window: { id: string; title: string }) {
    const bundleId = bundleByWindowId.get(window.id);
    if (bundleId === "com.apple.systempreferences" || (bundleId === undefined && window.title === "Settings")) return settingsBody;
    if (bundleId === "com.paneform.hero.waitlist" || (bundleId === undefined && window.title === "Waitlist")) return waitlistBody;
    return undefined;
  }
</script>

{#snippet waitlistBody()}
  <iframe class="waitlist-frame" src="/wm/waitlist/" title="Join the paneform wm waitlist"></iframe>
{/snippet}

{#snippet settingsBody()}<SettingsShortcuts />{/snippet}

{#if viewport}
  <WindowSurface contentForWindow={contentFor} {windows} {viewport} {focusedWindowId} {interactive} onselectwindow={(id) => onfocuswindow?.(id)} onclosewindow={(id) => onclosewindow?.(id)} onmovewindow={(id, point) => onmovewindow?.(id, point)} onresizewindow={(id, frame) => onresizewindow?.(id, frame)} />
{:else}
  <div class="display-surface"></div>
{/if}

<style>
.waitlist-frame { flex: 1; width: 100%; min-height: 0; border: 0; background: var(--color-page-background); }
.display-surface { position: absolute; inset: 0; border-radius: inherit; background: var(--color-screen-background); }</style>
