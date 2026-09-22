<script lang="ts">
  import type { SimulationState } from "@paneform/layout-browser";

  import DesktopDock from "../desktop/DesktopDock.svelte";
  import { laptopDisplayPreset } from "../desktop/display-presets.js";
  import type { DockItem, Frame } from "../desktop/desktop-model.js";
  import { generatedHeroState } from "./generated-hero-state.js";
  import { MACBOOK_DISPLAY_ID, HERO_APPS, type HeroAppTitle } from "./hero-model.js";

  let { state, interactive = false, hoveredApp = null, cursorApp = null, onactivate, onworkareachange }: { state: SimulationState | null; onworkareachange?: ((area: Frame) => void) | undefined; interactive?: boolean; hoveredApp?: HeroAppTitle | null; cursorApp?: HeroAppTitle | null; onactivate: ((app: HeroAppTitle) => void) | undefined; } = $props();
  const effective = $derived(state ?? generatedHeroState);
  const display = $derived(effective.topology.find(({ id }) => id === MACBOOK_DISPLAY_ID));
  const openWindows = $derived(new Set(effective.windows.map(({ bundleId }) => bundleId)));
  const items = $derived(HERO_APPS.map((app): DockItem => ({ id: app.title, title: app.title, icon: app.icon, open: app.title === "Paneform" ? effective.wmRunning !== false : openWindows.has(app.bundleId) })));
</script>

<DesktopDock {onworkareachange} {items} {interactive} {hoveredApp} {cursorApp} frame={display?.frame ?? laptopDisplayPreset.frame} workArea={display?.workArea ?? laptopDisplayPreset.workArea} onactivate={(id) => { const app = HERO_APPS.find(({ title }) => title === id); if (app) onactivate?.(app.title); }} />
