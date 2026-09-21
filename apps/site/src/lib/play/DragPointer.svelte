<script lang="ts">
  import type { Frame } from "$lib/desktop/desktop-model.js";
  import type { WindowDragPreview } from "$lib/desktop/window-drag-types.js";

  let { stage, viewport, preview }: {
    stage: HTMLElement | undefined;
    viewport: Frame;
    preview: WindowDragPreview;
  } = $props();

  interface SurfaceMetrics {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }

  let metrics = $state<SurfaceMetrics | null>(null);
  const sourceDisplayId = $derived(preview.displayId);
  const viewportX = $derived(viewport.x);
  const viewportY = $derived(viewport.y);
  const viewportWidth = $derived(viewport.width);
  const viewportHeight = $derived(viewport.height);
  const position = $derived.by(() => {
    if (!metrics) return "";
    const x = metrics.x + ((preview.pointer.x - viewportX) / viewportWidth) * metrics.width;
    const y = metrics.y + ((preview.pointer.y - viewportY) / viewportHeight) * metrics.height;
    return `translate(${x}px, ${y}px)`;
  });

  $effect(() => {
    if (!stage) return;

    const displayId = sourceDisplayId;
    const viewportGeometry = `${viewportX},${viewportY},${viewportWidth},${viewportHeight}`;
    let frame = 0;
    const foundSurface = [...stage.querySelectorAll<HTMLElement>(".device")]
      .find((device) => device.dataset.displayId === displayId)
      ?.querySelector<HTMLElement>(".display-surface");
    if (!foundSurface) {
      metrics = null;
      return;
    }
    const surface = foundSurface;
    const observer = new ResizeObserver(schedule);

    function measure(): void {
      if (!surface.isConnected) {
        metrics = null;
        return;
      }

      const stageBox = stage!.getBoundingClientRect();
      const surfaceBox = surface.getBoundingClientRect();
      metrics = {
        x: surfaceBox.left - stageBox.left,
        y: surfaceBox.top - stageBox.top,
        width: surfaceBox.width,
        height: surfaceBox.height,
      };
    }

    function schedule(): void {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    }

    stage.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    observer.observe(stage);
    observer.observe(surface);
    schedule();
    void viewportGeometry;
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      stage?.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  });
</script>

{#if metrics}
  <div class="drag-pointer phase-{preview.phase}" style:transform={position} aria-hidden="true">
    <span class="press-ring"></span>
    <svg viewBox="0 0 24 30" aria-hidden="true"><path d="M2 2v21l5.7-5.2 4 9.2 4-1.8-4-8.8H20z" /></svg>
    <span class="phase-badge">{preview.phase}</span>
  </div>
{/if}

<style>
  .drag-pointer { position: absolute; z-index: 100; inset: 0 auto auto 0; width: 0; height: 0; pointer-events: none; color: var(--color-page-foreground); }
  svg { position: absolute; top: -2px; left: -2px; width: 1.35rem; overflow: visible; filter: drop-shadow(0 1px 1px rgb(0 0 0 / 0.45)); }
  path { fill: var(--color-page-background); stroke: currentColor; stroke-linejoin: round; stroke-width: 1.5; }
  .press-ring { position: absolute; width: 2rem; aspect-ratio: 1; border: 2px solid currentColor; border-radius: 50%; transform: translate(-50%, -50%) scale(0.75); opacity: 0; }
  .phase-badge { position: absolute; top: 1.5rem; left: 1.1rem; border: 1px solid currentColor; border-radius: 999px; padding: 0.2rem 0.45rem; background: var(--color-page-background); color: var(--color-page-foreground); font-size: 0.65rem; font-weight: 700; line-height: 1; text-transform: uppercase; white-space: nowrap; box-shadow: 0 2px 8px rgb(0 0 0 / 0.2); }
  .phase-pressed .press-ring, .phase-dragging .press-ring { opacity: 0.65; transform: translate(-50%, -50%) scale(1); }
  .phase-pressed svg, .phase-dragging svg { transform: translate(1px, 1px); }
  .phase-released .press-ring { opacity: 0.8; animation: release 220ms ease-out both; }
  .phase-settling { opacity: 0.72; }
  @keyframes release { from { transform: translate(-50%, -50%) scale(0.7); } to { transform: translate(-50%, -50%) scale(1.5); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .phase-released .press-ring { animation: none; opacity: 0; } }
</style>
