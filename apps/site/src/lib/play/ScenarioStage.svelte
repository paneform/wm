<script lang="ts">
  import type { Keybinds } from "@paneform/layout";
  import type { Presentation, SimulationState, WindowDrag } from "@paneform/layout-browser";
  import { onMount } from "svelte";
  import DesktopDisplay from "$lib/desktop/DesktopDisplay.svelte";
  import DesktopDock from "$lib/desktop/DesktopDock.svelte";
  import DesktopTopBar from "$lib/desktop/DesktopTopBar.svelte";
  import Laptop from "$lib/desktop/Laptop.svelte";
  import WindowSurface from "$lib/desktop/WindowSurface.svelte";
  import type { AppIcon, DockItem, Frame, SurfaceWindow } from "$lib/desktop/desktop-model.js";
  import type { SurfaceDragPreview, SurfaceWindowDrag, WindowDragPreview } from "$lib/desktop/window-drag-types.js";
  import { HERO_APPS } from "$lib/hero/hero-model.js";
  import Keyboard from "$lib/hero/Keyboard.svelte";
  import SettingsShortcuts from "$lib/hero/SettingsShortcuts.svelte";
  import type { KeyboardController } from "$lib/hero/keyboard-controller.js";
  import DragPointer from "./DragPointer.svelte";
  import { windowsForDisplay } from "./projection.js";

  let {
    state: simulationState,
    presentation = {},
    controller,
    attachKeyboard = true,
    stand = true,
    label = "Interactive scenario displays",
    interactive = true,
    selectable = false,
    onactivate,
    onfocuswindow,
    onselectwindow,
    onclosewindow,
    onmovewindow,
    onresizewindow,
    ondragwindow,
    onpreviewdrag,
    dragPreview = null,
    onfocusworkspace,
    onshortcut,
    keybinds,
  }: {
    state: SimulationState;
    presentation?: Presentation;
    controller?: KeyboardController;
    stand?: boolean;
    attachKeyboard?: boolean;
    label?: string;
    interactive?: boolean;
    selectable?: boolean;
    onactivate?: (appId: string, displayId?: string) => void;
    onfocuswindow?: (id: string) => void;
    onselectwindow?: (id: string, displayId?: string) => void;
    onclosewindow?: (id: string) => void;
    onmovewindow?: (id: string, point: Pick<Frame, "x" | "y">) => Promise<void> | void;
    onresizewindow?: (id: string, frame: Frame) => Promise<void> | void;
    ondragwindow?: (gesture: WindowDrag) => Promise<void> | void;
    onpreviewdrag?: (preview: WindowDragPreview | null) => void;
    dragPreview?: WindowDragPreview | null;
    onfocusworkspace?: (name: string, displayId?: string) => void;
    onshortcut?: (event: KeyboardEvent) => void;
    keybinds?: Keybinds | undefined;
  } = $props();

  let stageElement = $state<HTMLElement>();
  const iconByBundle = new Map<string, AppIcon>(
    HERO_APPS.map((app) => [app.bundleId, app.icon]),
  );
  const appIdForWindow = (window: SimulationState["windows"][number]) =>
    window.bundleId ?? window.title?.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-") ?? window.id;
  const interactiveEnabled = $derived(interactive && (presentation.interactive ?? true));
  const windows = $derived(simulationState.windows.filter((window) => !window.hidden && !window.minimized));
  const openApps = $derived(new Set(windows.map(appIdForWindow)));
  const dockItems = $derived(
    HERO_APPS.map(
      (app): DockItem => ({
        id: app.bundleId,
        title: app.title,
        icon: app.icon,
        open: app.title === "Paneform" ? simulationState.wmRunning !== false : openApps.has(app.bundleId),
      }),
    ),
  );
  const workspaces = $derived.by(() => {
    const names = new Set<string>();
    for (const display of simulationState.topology) if (display.workspace) names.add(display.workspace);
    for (const window of simulationState.windows) {
      const workspace = window.workspace === undefined ? "1" : window.workspace;
      if (workspace !== null) names.add(workspace);
    }
    return [...names].sort().map((name) => ({
      name,
      apps: simulationState.windows
        .filter((window) => (window.workspace === undefined ? "1" : window.workspace) === name)
        .map((window) => {
          const icon = iconByBundle.get(window.bundleId ?? "");
          return icon ? { title: window.title ?? window.id, icon } : { title: window.title ?? window.id };
        }),
    }));
  });

  function surfaceWindows(display: SimulationState["topology"][number]): SurfaceWindow[] {
    const displayed = windowsForDisplay(simulationState, display);
    const previewWindow = dragPreview && simulationState.windows.find(({ id }) => id === dragPreview.windowId);
    const projected = previewWindow && !displayed.some(({ id }) => id === previewWindow.id)
      ? [...displayed, previewWindow]
      : displayed;
    return projected.map((window) => ({
      id: window.id,
      title: window.title ?? window.id,
      frame: window.frame,
    }));
  }

  function surfacePreview(): SurfaceDragPreview | null {
    if (!dragPreview) return null;
    const target = dragPreview.phase === "settling"
      ? simulationState.windows.find(({ id }) => id === dragPreview.windowId)?.frame
      : undefined;
    return { ...dragPreview, frame: target ?? dragPreview.frame };
  }

  function emitPreview(displayId: string, preview: SurfaceDragPreview | null): void {
    onpreviewdrag?.(preview ? { ...preview, displayId } : null);
  }

  function dragWindow(displayId: string, gesture: SurfaceWindowDrag): Promise<void> | void {
    if (ondragwindow) return ondragwindow({ ...gesture, displayId });
    return onmovewindow?.(gesture.windowId, {
      x: gesture.startFrame.x + gesture.to.x - gesture.from.x,
      y: gesture.startFrame.y + gesture.to.y - gesture.from.y,
    });
  }

  function deviceFor(id: string): "laptop" | "display" {
    return presentation.devices?.[id] ?? presentation.device ?? "laptop";
  }

  function isSettingsWindow(window: SurfaceWindow): boolean {
    const source = simulationState.windows.find(({ id }) => id === window.id);
    return source?.bundleId === "com.apple.systempreferences" ||
      (source?.bundleId === undefined && window.title === "Settings");
  }

  onMount(() => (attachKeyboard && stageElement && controller ? controller.attach(stageElement) : undefined));
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -- This scoped keyboard region must receive physical key events. -->
<section class="stage" bind:this={stageElement} role="application" tabindex="0" aria-label={label} onkeydowncapture={(event) => onshortcut?.(event)}>
  {#each simulationState.topology as display (display.id)}
    {@const laptop = deviceFor(display.id) === "laptop"}
    <div class:laptop class="device" data-display-id={display.id} style:--ratio={display.frame.width / display.frame.height}>
      {#snippet screenSnippet()}
        {#snippet settingsBody()}<SettingsShortcuts {keybinds} />{/snippet}
        <WindowSurface
          contentForWindow={(window) => isSettingsWindow(window) ? settingsBody : undefined}
          windows={surfaceWindows(display)}
          viewport={display.frame}
          focusedWindowId={simulationState.focusedWindow ?? null}
          interactive={interactiveEnabled}
          selectable={interactiveEnabled}
          allowMove={presentation.allowMove ?? true}
          allowResize={presentation.allowResize ?? true}
          motion={presentation.animate ?? true}
          onfocuswindow={(id) => onfocuswindow?.(id)}
           onselectwindow={(id) => onselectwindow?.(id, display.id)}
          onclosewindow={(id) => onclosewindow?.(id)}
          onmovewindow={(id, point) => onmovewindow?.(id, point)}
          onresizewindow={(id, frame) => onresizewindow?.(id, frame)}
          dragPreview={surfacePreview()}
          ondragwindow={(gesture) => dragWindow(display.id, gesture)}
          onpreviewdrag={(preview) => emitPreview(display.id, preview)}
        />
        {#if presentation.showTopBar ?? true}<DesktopTopBar {workspaces} focusedWorkspace={display.workspace} interactive={interactive && (simulationState.wmRunning !== false || selectable)} onfocusworkspace={(name) => onfocusworkspace?.(name, display.id)} notched={laptop} />{/if}
        {#if presentation.showDock ?? true}<DesktopDock items={dockItems} interactive={interactiveEnabled} frame={display.frame} workArea={display.workArea ?? display.frame} onactivate={(id) => onactivate?.(id, display.id)} />{/if}
      {/snippet}
       {#snippet keyboardSnippet()}{#if controller}<Keyboard {controller} />{/if}{/snippet}
      {#if laptop && (presentation.showKeyboard ?? true)}
        <Laptop screen={screenSnippet} keyboard={keyboardSnippet} open desktop motion={presentation.animate ?? true} paused={false} />
      {:else if laptop}
        <Laptop screen={screenSnippet} open desktop motion={presentation.animate ?? true} paused={false} />
      {:else}
          <DesktopDisplay screen={screenSnippet} powered motion={presentation.animate ?? true} paused={false} {stand} />
      {/if}
    </div>
  {/each}
  {#if dragPreview}
    {@const sourceDisplay = simulationState.topology.find(({ id }) => id === dragPreview.displayId)}
    {#if sourceDisplay}<DragPointer stage={stageElement} viewport={sourceDisplay.frame} preview={dragPreview} />{/if}
  {/if}
</section>

<div class="text-alternative">
  <h2>Current layout</h2>
  <p>The window manager is {simulationState.wmRunning === false ? "stopped" : simulationState.paused ? "paused" : "running"}.</p>
  {#each simulationState.topology as display (display.id)}
    <p>Display {display.id}, workspace {display.workspace ?? "none"}.</p>
    <ul>{#each windowsForDisplay(simulationState, display) as window (window.id)}<li>{window.title ?? window.id}{simulationState.focusedWindow === window.id ? " (focused)" : ""}</li>{/each}</ul>
  {/each}
</div>

<style>
  .stage { position: relative; display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 25rem), 1fr)); align-items: center; gap: clamp(1rem, 3vw, 3rem); padding: 0.5rem clamp(0.5rem, 1.5vw, 1.5rem); outline: none; }
  .stage:focus-visible { box-shadow: inset 0 0 0 2px var(--color-focus-ring); }
  .device { position: relative; width: min(100%, 60rem, calc(60svh * var(--ratio))); margin-inline: auto; }
  .device.laptop { width: min(100%, 60rem, calc(70svh / 1.1)); aspect-ratio: 1 / 1.1; }
  .device.laptop :global(.laptop-device) { --laptop-pivot: 1; position: absolute; inset: auto 0 0; }
  .text-alternative { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (min-width: 64rem) and (min-height: 40rem) { .device.laptop { aspect-ratio: 1 / 1.05; } }
</style>
