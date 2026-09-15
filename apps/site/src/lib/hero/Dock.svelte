<script lang="ts">
  import DesktopDock from "../desktop/DesktopDock.svelte";
  import { laptopDisplayPreset } from "../desktop/display-presets.js";
  import type { DockItem, Frame } from "../desktop/desktop-model.js";
  import type { HeroCommittedSnapshot } from "./create-hero-simulation.js";
  import { HERO_APPS, type HeroAppTitle } from "./hero-model.js";

  let { snapshot, interactive = false, hoveredApp = null, cursorApp = null, onactivate, onworkareachange }: { snapshot: HeroCommittedSnapshot | null; onworkareachange?: ((area: Frame) => void) | undefined; interactive?: boolean; hoveredApp?: HeroAppTitle | null; cursorApp?: HeroAppTitle | null; onactivate: ((app: HeroAppTitle) => void) | undefined; } = $props();
  const items = $derived(HERO_APPS.map((app): DockItem => ({ id: app.title, title: app.title, icon: app.icon, open: app.title === "Paneform" ? Boolean(snapshot?.wmRunning) : Boolean(snapshot?.apps[app.title]) })));
</script>

<DesktopDock {onworkareachange} {items} {interactive} {hoveredApp} {cursorApp} frame={laptopDisplayPreset.frame} workArea={laptopDisplayPreset.workArea} onactivate={(id) => { const app = HERO_APPS.find(({ title }) => title === id); if (app) onactivate?.(app.title); }} />
