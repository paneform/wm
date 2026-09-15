<script lang="ts">
  import DesktopTopBar from "../desktop/DesktopTopBar.svelte";
  import type { HeroCommittedSnapshot } from "./create-hero-simulation.js";
  import { generatedHeroSnapshot } from "./generated-hero-snapshot.js";
  import { getHeroApp, HERO_APPS, HERO_WORKSPACES, type HeroAppTitle, type HeroWorkspace } from "./hero-model.js";
  let { snapshot, interactive = false, onfocusworkspace }: { snapshot: HeroCommittedSnapshot | null; interactive?: boolean; onfocusworkspace: ((workspace: HeroWorkspace) => void) | undefined; } = $props();
  const appByWindow = $derived(new Map(HERO_APPS.flatMap(({ title }) => snapshot?.apps[title] ? [[snapshot.apps[title], title] as const] : [])));
  const workspaces = $derived(HERO_WORKSPACES.flatMap((name) => { const apps: HeroAppTitle[] = snapshot ? snapshot.state.windows.flatMap((window) => { const app = window.workspace === name ? appByWindow.get(window.id) : undefined; return app ? [app] : []; }) : [...(generatedHeroSnapshot.workspaces.find((workspace) => workspace.name === name)?.apps ?? [])]; return apps.length ? [{ name, apps: apps.map((title) => ({ title, icon: getHeroApp(title).icon })) }] : []; }));
  const focusedWorkspace = $derived(snapshot?.state.focusedWorkspace ?? generatedHeroSnapshot.focusedWorkspace);
  function focus(name: string) { const workspace = HERO_WORKSPACES.find((candidate) => candidate === name); if (workspace) onfocusworkspace?.(workspace); }
</script>
<DesktopTopBar {workspaces} {focusedWorkspace} {interactive} onfocusworkspace={focus} />
