<script lang="ts">
  import type { Presentation, SimulationState } from "@paneform/layout-browser";
  import { onMount } from "svelte";
  import DesktopDisplay from "$lib/desktop/DesktopDisplay.svelte";
  import DesktopDock from "$lib/desktop/DesktopDock.svelte";
  import DesktopTopBar from "$lib/desktop/DesktopTopBar.svelte";
  import Laptop from "$lib/desktop/Laptop.svelte";
  import WindowSurface from "$lib/desktop/WindowSurface.svelte";
  import type { AppIcon, DockItem, Frame, SurfaceWindow } from "$lib/desktop/desktop-model.js";
  import { HERO_APPS } from "$lib/hero/hero-model.js";
  import Keyboard from "$lib/hero/Keyboard.svelte";
  import type { KeyboardController } from "$lib/hero/keyboard-controller.js";
  import { windowsForDisplay } from "./projection.js";

  let {
    state,
    presentation = {},
    controller,
    interactive = true,
    selectable = false,
    onactivate,
    onfocuswindow,
    onselectwindow,
    onclosewindow,
    onmovewindow,
    onresizewindow,
    onfocusworkspace,
    onshortcut,
  }: {
    state: SimulationState;
    presentation?: Presentation;
    controller: KeyboardController;
    interactive?: boolean;
    selectable?: boolean;
    onactivate?: (appId: string, displayId?: string) => void;
    onfocuswindow?: (id: string) => void;
    onselectwindow?: (id: string, displayId?: string) => void;
    onclosewindow?: (id: string) => void;
    onmovewindow?: (id: string, point: Pick<Frame, "x" | "y">) => Promise<void> | void;
    onresizewindow?: (id: string, frame: Frame) => Promise<void> | void;
    onfocusworkspace?: (name: string, displayId?: string) => void;
    onshortcut?: (event: KeyboardEvent) => void;
  } = $props();

  // oxlint-disable-next-line no-unassigned-vars -- Svelte assigns this through bind:this.
  let stageElement: HTMLElement | undefined;
  const iconByBundle = new Map<string, AppIcon>(
    HERO_APPS.map((app) => [app.bundleId, app.icon]),
  );
  const appIdForWindow = (window: SimulationState["windows"][number]) =>
    window.bundleId ?? window.title?.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-") ?? window.id;
  const windows = $derived(state.windows.filter((window) => !window.hidden && !window.minimized));
  const openApps = $derived(new Set(windows.map(appIdForWindow)));
  const dockItems = $derived(
    HERO_APPS.map(
      (app): DockItem => ({
        id: app.bundleId,
        title: app.title,
        icon: app.icon,
        open: app.title === "Paneform" ? state.wmRunning !== false : openApps.has(app.bundleId),
      }),
    ),
  );
  const workspaces = $derived.by(() => {
    const names = new Set<string>();
    for (const display of state.topology) if (display.workspace) names.add(display.workspace);
    for (const window of state.windows) {
      const workspace = window.workspace === undefined ? "1" : window.workspace;
      if (workspace !== null) names.add(workspace);
    }
    return [...names].sort().map((name) => ({
      name,
      apps: state.windows
        .filter((window) => (window.workspace === undefined ? "1" : window.workspace) === name)
        .map((window) => {
          const icon = iconByBundle.get(window.bundleId ?? "");
          return icon ? { title: window.title ?? window.id, icon } : { title: window.title ?? window.id };
        }),
    }));
  });

  function surfaceWindows(display: SimulationState["topology"][number]): SurfaceWindow[] {
    return windowsForDisplay(state, display).map((window) => ({
      id: window.id,
      title: window.title ?? window.id,
      frame: window.frame,
    }));
  }

  function deviceFor(id: string): "laptop" | "display" {
    return presentation.devices?.[id] ?? presentation.device ?? "laptop";
  }

  onMount(() => (stageElement ? controller.attach(stageElement) : undefined));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- This scoped keyboard region must receive physical key events. -->
<section class="stage" bind:this={stageElement} role="application" tabindex="0" aria-label="Interactive scenario displays" onkeydowncapture={(event) => onshortcut?.(event)}>
  {#each state.topology as display (display.id)}
    {@const laptop = deviceFor(display.id) === "laptop"}
    <div class:laptop class="device" data-display-id={display.id} style:--ratio={display.frame.width / display.frame.height}>
      {#snippet screenSnippet()}
        <WindowSurface
          windows={surfaceWindows(display)}
          viewport={display.frame}
          focusedWindowId={state.focusedWindow ?? null}
           {interactive}
           {selectable}
          allowMove={presentation.allowMove ?? true}
          allowResize={presentation.allowResize ?? true}
          motion={presentation.animate ?? true}
          onfocuswindow={(id) => onfocuswindow?.(id)}
           onselectwindow={(id) => onselectwindow?.(id, display.id)}
          onclosewindow={(id) => onclosewindow?.(id)}
          onmovewindow={(id, point) => onmovewindow?.(id, point)}
          onresizewindow={(id, frame) => onresizewindow?.(id, frame)}
        />
        {#if presentation.showTopBar ?? true}<DesktopTopBar {workspaces} focusedWorkspace={display.workspace} interactive={interactive && (state.wmRunning !== false || selectable)} onfocusworkspace={(name) => onfocusworkspace?.(name, display.id)} notched={laptop} />{/if}
        {#if presentation.showDock ?? true}<DesktopDock items={dockItems} {interactive} frame={display.frame} workArea={display.workArea ?? display.frame} onactivate={(id) => onactivate?.(id, display.id)} />{/if}
      {/snippet}
      {#snippet keyboardSnippet()}<Keyboard {controller} />{/snippet}
      {#if laptop && (presentation.showKeyboard ?? true)}
        <Laptop screen={screenSnippet} keyboard={keyboardSnippet} open desktop motion={presentation.animate ?? true} paused={false} />
      {:else if laptop}
        <Laptop screen={screenSnippet} open desktop motion={presentation.animate ?? true} paused={false} />
      {:else}
         <DesktopDisplay screen={screenSnippet} powered motion={presentation.animate ?? true} paused={false} />
      {/if}
    </div>
  {/each}
</section>

<div class="text-alternative">
  <h2>Current layout</h2>
  <p>The window manager is {state.wmRunning === false ? "stopped" : state.paused ? "paused" : "running"}.</p>
  {#each state.topology as display (display.id)}
    <p>Display {display.id}, workspace {display.workspace ?? "none"}.</p>
    <ul>{#each windowsForDisplay(state, display) as window (window.id)}<li>{window.title ?? window.id}{state.focusedWindow === window.id ? " (focused)" : ""}</li>{/each}</ul>
  {/each}
</div>

<style>
  .stage { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 25rem), 1fr)); align-items: center; gap: clamp(2rem, 5vw, 5rem); min-height: 24rem; padding: 1.5rem clamp(0.75rem, 3vw, 2rem); outline: none; }
  .stage:focus-visible { box-shadow: inset 0 0 0 2px var(--color-focus-ring); }
  .device { position: relative; width: min(100%, 42rem, calc(44svh * var(--ratio))); margin-inline: auto; }
  .device.laptop { width: min(100%, 38rem, calc(56svh / 1.18)); aspect-ratio: 1 / 1.18; }
  .device.laptop :global(.laptop-device) { position: absolute; inset: auto 0 0; transform: perspective(var(--scene-perspective)) rotateX(var(--laptop-base-pitch)); transform-origin: 50% 100%; }
  .text-alternative { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (max-width: 42rem) { .stage { min-height: 18rem; padding-block: 1rem; } }
</style>
