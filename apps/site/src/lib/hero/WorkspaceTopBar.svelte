<script lang="ts">
  import type { SimulationState } from "@paneform/layout-browser";

  import DesktopTopBar from "../desktop/DesktopTopBar.svelte";
  import { generatedHeroState } from "./generated-hero-state.js";
  import { HERO_APPS, HERO_WORKSPACES, type HeroWorkspace } from "./hero-model.js";
  let { state, interactive = false, onfocusworkspace }: { state: SimulationState | null; interactive?: boolean; onfocusworkspace: ((workspace: HeroWorkspace) => void) | undefined; } = $props();
  const effective = $derived(state ?? generatedHeroState);
  function heroAppFor(title: string | undefined) {
    if (title === undefined) return undefined;
    return HERO_APPS.find((app) => app.title === title);
  }
  const workspaces = $derived(HERO_WORKSPACES.flatMap((name) => {
    const apps = effective.windows.flatMap((window) => {
      const app = window.workspace === name ? heroAppFor(window.title) : undefined;
      return app ? [{ title: app.title, icon: app.icon }] : [];
    });
    return apps.length ? [{ name, apps }] : [];
  }));
  const focusedWorkspace = $derived(effective.focusedWorkspace ?? null);
  function focus(name: string) { const workspace = HERO_WORKSPACES.find((candidate) => candidate === name); if (workspace) onfocusworkspace?.(workspace); }
</script>
<DesktopTopBar {workspaces} {focusedWorkspace} {interactive} onfocusworkspace={focus} />
