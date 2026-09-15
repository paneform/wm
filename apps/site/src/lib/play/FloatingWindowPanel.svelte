<script lang="ts">
  import { tick, type Snippet } from "svelte";
  import { INSPECTOR_GUTTER, positionInspector, type InspectorPosition } from "./inspector-position.js";

  let { displayId, refreshKey = 0, onclose, children }: { displayId: string | null; refreshKey?: number; onclose: () => void; children: Snippet } = $props();
  let panel = $state<HTMLElement>();
  let position = $state<InspectorPosition | null>(null);

  $effect(() => {
    const requestedDisplayId = displayId;
    const requestedRefreshKey = refreshKey;
    let cancelled = false;
    let frame = 0;
    let observer: ResizeObserver | undefined;
    const cleanups: (() => void)[] = [];

    const setup = async () => {
      await tick();
      if (cancelled || requestedDisplayId !== displayId || requestedRefreshKey !== refreshKey) return;
      const wrappers = [...document.querySelectorAll<HTMLElement>(".stage [data-display-id]")];
      const wrapper = wrappers.find((element) => element.dataset.displayId === requestedDisplayId) ?? wrappers[0];
      const anchor = wrapper?.querySelector<HTMLElement>(".display-surface") ?? document.querySelector<HTMLElement>(".stage .display-surface");
      if (!anchor || !panel) return;
      const panelElement = panel;

      const update = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (cancelled || !anchor.isConnected || !panelElement.isConnected) return;
           const visual = window.visualViewport;
           const viewport = { width: visual?.width ?? window.innerWidth, height: visual?.height ?? window.innerHeight, left: visual?.offsetLeft ?? 0, top: visual?.offsetTop ?? 0 };
           const bounds = anchor.getBoundingClientRect();
           const offscreen = bounds.bottom <= viewport.top || bounds.top >= viewport.top + viewport.height;
           position = offscreen && !panelElement.contains(document.activeElement)
             ? null
             : positionInspector(bounds, viewport, panelElement.scrollHeight);
        });
      };
      const listen = (target: EventTarget, type: string) => {
        target.addEventListener(type, update);
        cleanups.push(() => target.removeEventListener(type, update));
      };
      listen(window, "resize");
      window.addEventListener("scroll", update, true);
      cleanups.push(() => window.removeEventListener("scroll", update, true));
      if (window.visualViewport) {
        listen(window.visualViewport, "resize");
        listen(window.visualViewport, "scroll");
      }
      observer = new ResizeObserver(update);
      observer.observe(anchor);
      observer.observe(panelElement);
      update();
    };
    setup();

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
      cleanups.forEach((cleanup) => cleanup());
    };
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -- Escape closes only while focus is inside this non-modal region. -->
<div
  bind:this={panel}
  data-floating-inspector
  role="region"
  aria-label="Window inspector"
  data-placement={position?.placement}
  class:positioned={position}
  style:left={`${position?.left ?? INSPECTOR_GUTTER}px`}
  style:top={`${position?.top ?? INSPECTOR_GUTTER}px`}
  style:width={`${position?.width ?? 312}px`}
  style:max-height={`${position?.maxHeight ?? 0}px`}
  onkeydown={(event) => { if (event.key === "Escape" && !event.isComposing) { event.stopPropagation(); onclose(); } }}
>
  {@render children()}
</div>

<style>
  [data-floating-inspector] { position: fixed; z-index: calc(var(--layer-screen-dock) + 1); box-sizing: border-box; max-width: calc(100vw - 24px); min-width: 0; overflow: auto; overscroll-behavior: contain; visibility: hidden; color: var(--color-page-foreground); }
  [data-floating-inspector].positioned { visibility: visible; }
  [data-floating-inspector] :global(aside) { box-sizing: border-box; max-width: 100%; min-width: 0; }
</style>
