<script lang="ts">
  import SettingsShortcuts from "./SettingsShortcuts.svelte";
  import WindowSurface from "../desktop/WindowSurface.svelte";
  import type { Frame, SurfaceWindow } from "../desktop/desktop-model.js";
  import { mapSurfaceWindows } from "../desktop/surface-adapter.js";
  import type { HeroCommittedSnapshot } from "./create-hero-simulation.js";
  import { generatedHeroSnapshot } from "./generated-hero-snapshot.js";
  import { MACBOOK_DISPLAY_ID, HERO_APPS, type HeroAppTitle } from "./hero-model.js";

  let { snapshot, displayId, interactive = false, onclosewindow, onfocuswindow, onmovewindow, onresizewindow }: { snapshot: HeroCommittedSnapshot | null; displayId: string; interactive?: boolean; onresizewindow?: ((app: HeroAppTitle, frame: Frame) => Promise<void> | void) | undefined; onclosewindow?: ((app: HeroAppTitle) => void) | undefined; onfocuswindow?: ((app: HeroAppTitle) => void) | undefined; onmovewindow?: ((app: HeroAppTitle, point: Pick<Frame, "x" | "y">) => Promise<void> | void) | undefined; } = $props();
  const display = $derived(snapshot?.state.topology.find(({ id }) => id === displayId));
  const workspace = $derived(snapshot?.state.workspaces.find(({ visibleOnDisplay }) => visibleOnDisplay === displayId));
  const fallbackDisplay = generatedHeroSnapshot.displays.find(({ id }) => id === displayId);
  const fallbackWorkspace = generatedHeroSnapshot.workspaces.find(({ visibleOnDisplay }) => visibleOnDisplay === displayId);
  const viewport = $derived.by((): Frame | null => { const value = display ?? fallbackDisplay; if (!value) return null; return value.id === MACBOOK_DISPLAY_ID ? value.frame : value.workArea; });
  function appForWindow(id: string): HeroAppTitle | null { if (snapshot) { for (const app of HERO_APPS) if (snapshot.apps[app.title] === id) return app.title; return null; } const fallback = generatedHeroSnapshot.windows.find((window) => `fallback:${window.app}` === id); return fallback?.app ?? null; }
  const windows = $derived.by((): SurfaceWindow[] => {
    if (snapshot && display && workspace) return mapSurfaceWindows(snapshot.state.windows, (window) => window.workspace === workspace.name && !window.parked ? appForWindow(window.id) : null);
    return generatedHeroSnapshot.windows.filter((window) => window.managed && !window.parked && window.workspace === fallbackWorkspace?.name).map((window) => ({ id: `fallback:${window.app}`, title: window.app, frame: window.frame }));
  });
  const focusedWindowId = $derived(snapshot?.state.focusedWindow ?? (generatedHeroSnapshot.focusedApp ? `fallback:${generatedHeroSnapshot.focusedApp}` : null));
  function withApp(id: string, callback: ((app: HeroAppTitle) => Promise<void> | void) | undefined): Promise<void> | void { const app = appForWindow(id); if (app) return callback?.(app); }
</script>

{#snippet settingsBody()}<SettingsShortcuts />{/snippet}

{#if viewport}
  <WindowSurface contentForWindow={(window) => window.title === "Settings" ? settingsBody : undefined} {windows} {viewport} {focusedWindowId} {interactive} onselectwindow={(id) => withApp(id, onfocuswindow)} onclosewindow={(id) => withApp(id, onclosewindow)} onmovewindow={(id, point) => withApp(id, (app) => onmovewindow?.(app, point))} onresizewindow={(id, frame) => withApp(id, (app) => onresizewindow?.(app, frame))} />
{:else}
  <div class="display-surface"></div>
{/if}

<style>.display-surface { position: absolute; inset: 0; border-radius: inherit; background: var(--color-screen-background); }</style>
