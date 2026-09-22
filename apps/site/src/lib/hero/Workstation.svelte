<script lang="ts">
  import type { SimulationState } from "@paneform/layout-browser";

  import DisplaySurface from "./DisplaySurface.svelte";
  import Laptop from "../desktop/Laptop.svelte";
  import Dock from "./Dock.svelte";
  import Keyboard from "./Keyboard.svelte";
  import PaneformWordmark from "./PaneformWordmark.svelte";
  import ShortcutReadout from "./ShortcutReadout.svelte";
  import WorkspaceTopBar from "./WorkspaceTopBar.svelte";
  import type { Frame } from "../desktop/desktop-model.js";
  import { MACBOOK_DISPLAY_ID, type HeroAppTitle, type HeroWorkspace } from "./hero-model.js";
  import type { KeyboardController } from "./keyboard-controller.js";

  export type ScenePhase = "closed" | "opening" | "desktop" | "complete";

  let {
    state,
    phase,
    controller,
    interactive = false,
    dockInteractive = false,
    paused = false,
    fallback = false,
    cursorApp = null,
    paneformLaunching = false,
    onactivate,
    onclosewindow,
    onfocuswindow,
    onfocusworkspace,
    onmovewindow,
    onresizewindow,
    onworkareachange,
  }: {
    state: SimulationState | null;
    onworkareachange?: (area: Frame) => void;
    phase: ScenePhase;
    controller: KeyboardController;
    interactive?: boolean;
    dockInteractive?: boolean;
    paused?: boolean;
    fallback?: boolean;
    cursorApp?: HeroAppTitle | null;
    paneformLaunching?: boolean;
    onactivate?: (app: HeroAppTitle) => void;
    onclosewindow?: (windowId: string) => void;
    onfocuswindow?: (windowId: string) => void;
    onfocusworkspace?: (workspace: HeroWorkspace) => void;
    onmovewindow?: (windowId: string, point: { x: number; y: number }) => Promise<void> | void;
    onresizewindow?: (windowId: string, frame: Frame) => Promise<void> | void;
  } = $props();

  const open = $derived(fallback || phase !== "closed");
  const desktop = $derived(
    fallback || phase === "opening" || phase === "desktop" || phase === "complete",
  );
  const macBookInteractive = $derived(interactive && desktop);
  const macBookDockInteractive = $derived((dockInteractive || interactive) && desktop);
</script>

<div
  class:desktop
  class:open
  class:paused
  class="scene"
>
  {#snippet laptopScreen()}
            <DisplaySurface
              {state}
              displayId={MACBOOK_DISPLAY_ID}
              interactive={macBookInteractive}
              {onclosewindow}
              {onfocuswindow}
              {onmovewindow}
              {onresizewindow}
            />
            <WorkspaceTopBar
              {state}
              interactive={macBookInteractive}
              {onfocusworkspace}
            />
            <ShortcutReadout {controller} />
            <Dock
              {onworkareachange}
              {state}
              interactive={macBookDockInteractive}
              {cursorApp}
              {onactivate}
            />
            {#if paneformLaunching}
              <div class="paneform-splash" role="status" aria-label="Paneform WM is starting">
                <PaneformWordmark clipId="paneform-splash-clip" />
              </div>
            {/if}
  {/snippet}
  {#snippet laptopKeyboard()}<Keyboard {controller} />{/snippet}
  <Laptop class="laptop" screen={laptopScreen} keyboard={laptopKeyboard} {open} {desktop} {paused} />
</div>

<style>
  .scene {
    position: relative;
    width: 100%;
    aspect-ratio: var(--scene-stacked-aspect);
    pointer-events: none;
    transform-style: preserve-3d;
  }

  .scene.paused,
  .scene.paused * {
    animation-play-state: paused !important;
  }

  .scene :global(.laptop) {
    position: absolute;
    z-index: var(--layer-laptop);
    inset: var(--laptop-solo-top) auto auto 50%;
    width: var(--laptop-solo-width);
    aspect-ratio: var(--macbook-deck-aspect);
    transform: translateX(-50%);
    transition:
      width var(--motion-scene) var(--easing-mechanical),
      inset var(--motion-scene) var(--easing-mechanical),
      transform var(--motion-scene) var(--easing-mechanical);
  }

  .paneform-splash {
    position: absolute;
    z-index: var(--layer-controls);
    inset: 50% auto auto 50%;
    display: grid;
    width: min(54%, 18rem);
    justify-items: center;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border: var(--stroke-hairline) solid var(--color-line-default);
    border-radius: var(--radius-control);
    background: color-mix(in srgb, var(--color-surface-base) 92%, transparent);
    box-shadow: 0 var(--space-2) var(--space-5)
      color-mix(in srgb, var(--color-page-background) 45%, transparent);
    transform: translate(-50%, -50%);
    animation: paneform-splash-in var(--motion-feedback) var(--easing-standard) both;
    pointer-events: none;
  }

  .paneform-splash :global(svg) { width: 100%; }
  @keyframes paneform-splash-in {
    from { opacity: 0; transform: translate(-50%, -47%) scale(0.98); }
  }

  @container stage (max-width: 45rem) {
    .scene {
      aspect-ratio: 1 / 1.1;
      --laptop-solo-width: min(84%, 42rem);
      --laptop-solo-top: 50%;
    }
  }

  @container stage (min-width: 72rem) {
    .scene { aspect-ratio: var(--scene-wide-aspect); }
    .scene :global(.laptop) {
      inset: var(--laptop-intro-wide-top) auto auto var(--laptop-intro-wide-left);
      width: var(--laptop-intro-wide-width);
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: var(--motion-reduced) !important; transition-duration: var(--motion-reduced) !important; }
  }
</style>
