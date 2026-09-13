<script lang="ts">
  import { untrack, type Snippet } from "svelte";
  import { resizeEdges, resizeFrame, type ResizeEdge } from "../hero/resize-frame.js";
  import { updateWindowStack } from "../hero/window-stack.js";
  import type { Frame, SurfaceWindow } from "./desktop-model.js";

  let { contentForWindow, windows, viewport, focusedWindowId, interactive = false, selectable = false, allowMove = true, allowResize = true, motion = true, onfocuswindow, onselectwindow, onclosewindow, onmovewindow, onresizewindow }: {
    contentForWindow?: (window: SurfaceWindow) => Snippet | undefined;
    windows: readonly SurfaceWindow[]; viewport: Frame; focusedWindowId: string | null; interactive?: boolean; selectable?: boolean; allowMove?: boolean; allowResize?: boolean; motion?: boolean;
    onfocuswindow?: (id: string) => void; onselectwindow?: (id: string) => void; onclosewindow?: (id: string) => void;
    onmovewindow?: (id: string, point: Pick<Frame, "x" | "y">) => Promise<void> | void; onresizewindow?: (id: string, frame: Frame) => Promise<void> | void;
  } = $props();
  interface Drag { pointerId: number; windowId: string; startClientX: number; startClientY: number; startX: number; startY: number; startFrame: Frame; edge: ResizeEdge | undefined; width: number; height: number; x: number; y: number; surfaceWidth: number; surfaceHeight: number; }
  let drag = $state<Drag | null>(null);
  let windowStack = $state<string[]>([]);
  $effect(() => { windowStack = updateWindowStack(untrack(() => windowStack), windows.map(({ id }) => id), focusedWindowId); });
  $effect(() => {
    if (drag && (!interactive || !windows.some(({ id }) => id === drag?.windowId) || (drag.edge ? !allowResize : !allowMove))) drag = null;
  });
  function styleFor(window: SurfaceWindow) { const value = drag?.windowId === window.id ? drag : window.frame; return `--window-x:${((value.x - viewport.x) / viewport.width) * 100}%;--window-y:${((value.y - viewport.y) / viewport.height) * 100}%;--window-width:${(value.width / viewport.width) * 100}%;--window-height:${(value.height / viewport.height) * 100}%`; }
  function select(id: string) { if (!interactive && !selectable) return; onselectwindow?.(id); if (interactive && focusedWindowId !== id) onfocuswindow?.(id); }
  function pointerSelect(event: PointerEvent, id: string) {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest(".close-window"))) return;
    const element = event.currentTarget;
    if ((interactive || selectable) && element instanceof HTMLElement) element.querySelector<HTMLElement>(".window-titlebar")?.focus({ preventScroll: true });
    select(id);
  }
  function start(event: PointerEvent, window: SurfaceWindow, edge?: ResizeEdge) { if (!interactive || event.button !== 0 || drag || (edge ? !allowResize : !allowMove)) return; const target = event.target; const element = event.currentTarget; if (!(target instanceof Element) || (!edge && !target.closest(".window-titlebar")) || !(element instanceof HTMLElement)) return; const surface = element.closest(".display-surface"); if (!(surface instanceof HTMLElement)) return; const bounds = surface.getBoundingClientRect(); element.setPointerCapture(event.pointerId); drag = { pointerId: event.pointerId, windowId: window.id, startClientX: event.clientX, startClientY: event.clientY, startX: window.frame.x, startY: window.frame.y, startFrame: { ...window.frame }, edge, width: window.frame.width, height: window.frame.height, x: window.frame.x, y: window.frame.y, surfaceWidth: bounds.width, surfaceHeight: bounds.height }; event.preventDefault(); }
  function move(event: PointerEvent) { if (!drag || drag.pointerId !== event.pointerId) return; const dx = ((event.clientX - drag.startClientX) / drag.surfaceWidth) * viewport.width; const dy = ((event.clientY - drag.startClientY) / drag.surfaceHeight) * viewport.height; if (drag.edge) Object.assign(drag, resizeFrame(drag.startFrame, drag.edge, dx, dy)); else { drag.x = drag.startX + dx; drag.y = drag.startY + dy; } }
  async function finish(event: PointerEvent, commit: boolean) { if (!drag || drag.pointerId !== event.pointerId) return; if (commit) move(event); const completed = drag; const moved = Math.hypot(event.clientX - completed.startClientX, event.clientY - completed.startClientY) >= 3; if (!commit || !moved) { drag = null; return; } try { if (completed.edge) await onresizewindow?.(completed.windowId, { x: completed.x, y: completed.y, width: completed.width, height: completed.height }); else await onmovewindow?.(completed.windowId, { x: completed.x, y: completed.y }); } finally { if (drag === completed) drag = null; } }
</script>

<div class="display-surface" class:motion>
  {#each windows as window (window.id)}
    {@const content = contentForWindow?.(window)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="managed-window" class:focused={focusedWindowId === window.id} class:dragging={drag?.windowId === window.id} class:movable={interactive && allowMove} style={styleFor(window)} style:z-index={focusedWindowId === window.id ? windowStack.length + 1 : windowStack.indexOf(window.id) + 1} role="group" aria-label={`${window.title} window`} data-window-id={window.id} onpointerdowncapture={(event) => pointerSelect(event, window.id)}>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
       <div class="window-titlebar" role="toolbar" aria-label={`${window.title} window title bar`} tabindex={interactive || selectable ? 0 : -1} onkeydown={(event) => { if (!event.defaultPrevented && event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); select(window.id); } }} onpointerdown={(event) => start(event, window)} onpointermove={move} onpointerup={(event) => finish(event, true)} onpointercancel={(event) => finish(event, false)}>
        <span class="traffic"><button class="close-window" disabled={!interactive} aria-label={`Close ${window.title}`} onpointerdown={(event) => event.stopPropagation()} onclick={(event) => { event.stopPropagation(); onclosewindow?.(window.id); }}></button><i></i><i></i></span><span>{window.title}</span>
      </div>
      {#if content}{@render content()}{:else}<span class="app-glyph" aria-hidden="true">{window.title.slice(0, 1)}</span>{/if}
      {#if interactive && allowResize}{#each resizeEdges as edge}<div class="resize-handle resize-{edge}" data-resize-edge={edge} aria-hidden="true" onpointerdown={(event) => start(event, window, edge)} onpointermove={move} onpointerup={(event) => finish(event, true)} onpointercancel={(event) => finish(event, false)}></div>{/each}{/if}
    </div>
  {/each}
</div>

<style>
  .display-surface { isolation: isolate; position: absolute; inset: 0; overflow: hidden; border-radius: inherit; background: var(--color-screen-background); color: var(--color-page-foreground); }
  .managed-window { z-index: 0; position: absolute; inset-block-start: var(--window-y); inset-inline-start: var(--window-x); width: var(--window-width); height: var(--window-height); display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; border: var(--stroke-hairline) solid var(--color-window-unfocused); border-radius: var(--radius-screen-window); padding: 0; background: var(--color-window-background); color: var(--color-page-foreground); font: inherit; }
  .motion .managed-window { transition: transform var(--motion-window) var(--easing-layout), inset var(--motion-window) var(--easing-layout), width var(--motion-window) var(--easing-layout), height var(--motion-window) var(--easing-layout), border-color var(--motion-feedback) var(--easing-standard); }
  .managed-window.focused { z-index: 1; border-width: var(--stroke-strong); border-color: var(--color-window-focus); } .managed-window.dragging { transition: none; }
  .resize-handle { position: absolute; touch-action: none; user-select: none; z-index: 1; } .resize-n,.resize-s { left: 8px; right: 8px; height: 5px; cursor: ns-resize; } .resize-e,.resize-w { top: 8px; bottom: 8px; width: 5px; cursor: ew-resize; } .resize-n,.resize-ne,.resize-nw { top: 0; } .resize-s,.resize-se,.resize-sw { bottom: 0; } .resize-e,.resize-ne,.resize-se { right: 0; } .resize-w,.resize-nw,.resize-sw { left: 0; } .resize-ne,.resize-nw,.resize-se,.resize-sw { width: 8px; height: 8px; z-index: 2; } .resize-ne,.resize-sw { cursor: nesw-resize; } .resize-nw,.resize-se { cursor: nwse-resize; }
  .close-window:focus-visible { outline: var(--stroke-strong) solid var(--color-focus-ring); outline-offset: calc(-1 * var(--stroke-strong)); } .close-window { position: relative; z-index: 3; }
  .window-titlebar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; flex: 0 0 var(--window-titlebar-height); border-block-end: var(--stroke-hairline) solid var(--color-line-default); padding-inline: var(--window-titlebar-padding); font-size: var(--type-screen-label); letter-spacing: var(--type-tracking-label); text-transform: uppercase; touch-action: none; user-select: none; } .movable .window-titlebar { cursor: grab; } .dragging .window-titlebar { cursor: grabbing; }
  .traffic { display: flex; gap: var(--window-control-gap); } .traffic i,.traffic button { width: var(--window-control-size); aspect-ratio: 1; border: 0; border-radius: 50%; padding: 0; background: var(--color-control-close); } .traffic button:not(:disabled) { cursor: pointer; } .traffic i:nth-child(2) { background: var(--color-control-minimize); } .traffic i:nth-child(3) { background: var(--color-control-maximize); }
  .app-glyph { display: grid; flex: 1; place-items: center; color: var(--color-page-secondary); font: var(--type-weight-strong) var(--type-app-glyph)/1 var(--type-family-system); }
  @media (prefers-reduced-motion: reduce) { .motion .managed-window { transition-duration: 0ms; } }
</style>
