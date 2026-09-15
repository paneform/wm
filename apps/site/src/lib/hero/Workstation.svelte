<script lang="ts">
  import { heroFeatures } from "./feature-flags.js";
  import DisplaySurface from "./DisplaySurface.svelte";
  import DesktopDisplay from "../desktop/DesktopDisplay.svelte";
  import Laptop from "../desktop/Laptop.svelte";
  import Dock from "./Dock.svelte";
  import Keyboard from "./Keyboard.svelte";
  import PaneformWordmark from "./PaneformWordmark.svelte";
  import ShortcutReadout from "./ShortcutReadout.svelte";
  import WorkspaceTopBar from "./WorkspaceTopBar.svelte";
  import type {
    HeroCommittedSnapshot,
    HeroWindowFrame,
  } from "./create-hero-simulation.js";
  import {
    MACBOOK_DISPLAY_ID,
    STUDIO_DISPLAY_ID,
    type HeroAppTitle,
    type HeroWorkspace,
  } from "./hero-model.js";
  import type { KeyboardController } from "./keyboard-controller.js";

  export type ScenePhase =
    | "closed"
    | "opening"
    | "signal"
    | "desktop"
    | "monitor"
    | "connected"
    | "powered"
    | "complete";

  let {
    snapshot,
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
    snapshot: HeroCommittedSnapshot | null;
    onworkareachange?: (area: HeroWindowFrame) => void;
    phase: ScenePhase;
    controller: KeyboardController;
    interactive?: boolean;
    dockInteractive?: boolean;
    paused?: boolean;
    fallback?: boolean;
    cursorApp?: HeroAppTitle | null;
    paneformLaunching?: boolean;
    onactivate?: (app: HeroAppTitle) => void;
    onclosewindow?: (app: HeroAppTitle) => void;
    onfocuswindow?: (app: HeroAppTitle) => void;
    onfocusworkspace?: (workspace: HeroWorkspace) => void;
    onmovewindow?: (app: HeroAppTitle, point: { x: number; y: number }) => Promise<void> | void;
    onresizewindow?: (app: HeroAppTitle, frame: HeroWindowFrame) => Promise<void> | void;
  } = $props();

  const hasStudio = $derived(
    heroFeatures.secondMonitor && (fallback ||
      phase === "monitor" ||
      phase === "connected" ||
      phase === "powered" ||
      phase === "complete" ||
      Boolean(snapshot?.state.topology.some(({ id }) => id === STUDIO_DISPLAY_ID))),
  );
  const powered = $derived(fallback || phase === "powered" || phase === "complete");
  const open = $derived(fallback || phase !== "closed");
  const desktop = $derived(
    fallback ||
      phase === "opening" ||
      phase === "desktop" ||
      phase === "monitor" ||
      phase === "connected" ||
      phase === "powered" ||
      phase === "complete",
  );
  const cabled = $derived(
    fallback || phase === "connected" || phase === "powered" || phase === "complete",
  );
  const macBookInteractive = $derived(interactive && desktop);
  const macBookDockInteractive = $derived((dockInteractive || interactive) && desktop);
  const studioInteractive = $derived(interactive && powered);
</script>

<div
  class:connected={hasStudio}
  class:cabled
  class:desktop
  class:open
  class:paused
  class:powered
  class="scene"
>
  {#if heroFeatures.secondMonitor}
  <svg class="cable cable-wide" viewBox="0 0 1760 1100" aria-hidden="true">
    <path pathLength="1" d="M 660 380 C 690 500, 740 560, 790 550" />
    <circle cx="660" cy="380" r="8" />
    <circle cx="790" cy="550" r="8" />
  </svg>
  <svg class="cable cable-stacked" viewBox="0 0 1100 1550" aria-hidden="true">
    <path pathLength="1" d="M 300 624 C 300 824, 230 940, 310 1100" />
    <circle cx="300" cy="624" r="8" />
    <circle cx="310" cy="1100" r="8" />
  </svg>

  {#snippet studioScreen()}
          <DisplaySurface
            {snapshot}
            displayId={STUDIO_DISPLAY_ID}
            interactive={studioInteractive}
            {onclosewindow}
            {onfocuswindow}
            {onmovewindow}
            {onresizewindow}
          />
  {/snippet}
  <DesktopDisplay class="studio" screen={studioScreen} {powered} {paused} />
  {/if}

  {#snippet laptopScreen()}
            <DisplaySurface
              {snapshot}
              displayId={MACBOOK_DISPLAY_ID}
              interactive={macBookInteractive}
              {onclosewindow}
              {onfocuswindow}
              {onmovewindow}
              {onresizewindow}
            />
            <WorkspaceTopBar
              {snapshot}
              interactive={macBookInteractive}
              {onfocusworkspace}
            />
            <ShortcutReadout {controller} />
            <Dock
              {onworkareachange}
              {snapshot}
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

  .cable {
    position: absolute;
    z-index: var(--layer-cable);
    inset: 0;
    width: 100%;
    height: 100%;
    overflow: visible;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--motion-feedback) var(--easing-standard);
  }

  .cable-wide { display: none; }

  .cable path {
    fill: none;
    stroke: var(--color-cable);
    stroke-width: var(--cable-stroke);
    stroke-dasharray: 1;
    stroke-dashoffset: 1;
    transition: stroke-dashoffset var(--motion-wire) linear;
    vector-effect: non-scaling-stroke;
  }

  .cable circle { fill: var(--color-state-connected); opacity: 0; }
  .scene.cabled .cable { opacity: 1; }
  .scene.cabled .cable path { stroke-dashoffset: 0; }
  .scene.cabled .cable circle { opacity: 1; transition: opacity var(--motion-feedback) var(--motion-wire); }

  .scene :global(.studio) {
    position: absolute;
    z-index: var(--layer-monitor);
    inset: var(--studio-stacked-top) auto auto var(--studio-stacked-left);
    width: var(--studio-stacked-width);
    aspect-ratio: var(--studio-total-aspect);
    opacity: 0;
    transform: translateY(var(--device-enter-distance));
    transition:
      opacity var(--motion-monitor) var(--easing-standard),
      transform var(--motion-monitor) var(--easing-standard);
  }

  .scene.connected :global(.studio) { opacity: 1; transform: none; }

  .scene :global(.laptop) {
    position: absolute;
    z-index: var(--layer-laptop);
    inset: var(--laptop-solo-top) auto auto 50%;
    width: var(--laptop-solo-width);
    aspect-ratio: var(--macbook-deck-aspect);
    /* Center after projection so perspective stays aligned with the laptop. */
    transform: translateX(-50%) perspective(var(--scene-perspective)) rotateX(var(--laptop-base-pitch));
    transform-style: preserve-3d;
    transition:
      width var(--motion-scene) var(--easing-mechanical),
      inset var(--motion-scene) var(--easing-mechanical),
      transform var(--motion-scene) var(--easing-mechanical);
  }

  .scene.connected :global(.laptop) {
    inset: var(--laptop-stacked-top) auto auto var(--laptop-stacked-left);
    width: var(--laptop-stacked-width);
    transform: perspective(var(--scene-perspective)) rotateX(var(--laptop-base-pitch));
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

    .scene :global(.studio),
    .cable { display: none; }

    .scene.connected :global(.laptop) {
      inset: var(--laptop-solo-top) auto auto 50%;
      width: var(--laptop-solo-width);
      transform: translateX(-50%) perspective(var(--scene-perspective))
        rotateX(var(--laptop-base-pitch));
    }
  }

  @container stage (min-width: 72rem) {
    .scene { aspect-ratio: var(--scene-wide-aspect); }
    .cable-stacked { display: none; }
    .cable-wide { display: block; }
    .scene :global(.studio) { inset: var(--studio-wide-top) auto auto var(--studio-wide-left); width: var(--studio-wide-width); }
    .scene :global(.laptop) {
      inset: var(--laptop-intro-wide-top) auto auto var(--laptop-intro-wide-left);
      width: var(--laptop-intro-wide-width);
      transform: perspective(var(--scene-perspective)) rotateX(var(--laptop-base-pitch));
    }
    .scene.connected :global(.laptop) {
      inset: var(--laptop-wide-top) auto auto var(--laptop-wide-left);
      width: var(--laptop-wide-width);
      transform: perspective(var(--scene-perspective)) rotateX(var(--laptop-base-pitch));
    }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: var(--motion-reduced) !important; transition-duration: var(--motion-reduced) !important; }
  }
</style>
