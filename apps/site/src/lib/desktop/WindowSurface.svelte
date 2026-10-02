<script lang="ts">
  import { onMount, untrack, type Snippet } from "svelte";
  import { resizeEdges, resizeFrame, type ResizeEdge } from "../hero/resize-frame.js";
  import { updateWindowStack } from "../hero/window-stack.js";
  import type { Frame, SurfaceWindow } from "./desktop-model.js";
  import {
    cancelWindowDragCapture,
    createWindowDragCapture,
    finishWindowDragCapture,
    updateWindowDragCapture,
    type SurfaceBounds,
    type WindowDragCapture,
  } from "./window-drag-capture.js";
  import type { SurfaceDragPreview, SurfaceWindowDrag } from "./window-drag-types.js";

  let { contentForWindow, windows, viewport, focusedWindowId, interactive = false, selectable = false, allowMove = true, allowResize = true, motion = true, onfocuswindow, onselectwindow, onclosewindow, onmovewindow, onresizewindow, ondragwindow, onpreviewdrag, dragPreview = null }: {
    contentForWindow?: (window: SurfaceWindow) => Snippet | undefined;
    windows: readonly SurfaceWindow[]; viewport: Frame; focusedWindowId: string | null; interactive?: boolean; selectable?: boolean; allowMove?: boolean; allowResize?: boolean; motion?: boolean;
    onfocuswindow?: (id: string) => void; onselectwindow?: (id: string) => void; onclosewindow?: (id: string) => void;
    onmovewindow?: (id: string, point: Pick<Frame, "x" | "y">) => Promise<void> | void; onresizewindow?: (id: string, frame: Frame) => Promise<void> | void;
    ondragwindow?: (gesture: SurfaceWindowDrag) => Promise<void> | void; onpreviewdrag?: (preview: SurfaceDragPreview | null) => void; dragPreview?: SurfaceDragPreview | null;
  } = $props();
  interface Drag { pointerId: number; windowId: string; startClientX: number; startClientY: number; startX: number; startY: number; startFrame: Frame; edge: ResizeEdge | undefined; width: number; height: number; x: number; y: number; surfaceWidth: number; surfaceHeight: number; bounds: SurfaceBounds; target: HTMLElement; capture: WindowDragCapture | undefined; committing: boolean; pointer: { x: number; y: number }; }
  let drag = $state<Drag | null>(null);
  let windowStack = $state<string[]>([]);
  $effect(() => { windowStack = updateWindowStack(untrack(() => windowStack), windows.map(({ id }) => id), focusedWindowId); });
  $effect(() => {
    if (drag && (!interactive || !windows.some(({ id }) => id === drag?.windowId) || (drag.edge ? !allowResize : !allowMove))) cancelDrag();
  });
  onMount(() => {
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") cancelDrag(); };
    const cancel = () => cancelDrag();
    const visibilitychange = () => { if (document.hidden) cancelDrag(); };
    window.addEventListener("keydown", keydown);
    window.addEventListener("blur", cancel);
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", visibilitychange);
    return () => { window.removeEventListener("keydown", keydown); window.removeEventListener("blur", cancel); window.removeEventListener("pagehide", cancel); document.removeEventListener("visibilitychange", visibilitychange); cancelDrag(); };
  });
  function displayedFrame(window: SurfaceWindow) { if (dragPreview?.windowId === window.id) return dragPreview.frame; return drag?.windowId === window.id ? drag : window.frame; }
  function styleFor(window: SurfaceWindow) { const value = displayedFrame(window); return `--window-x:${((value.x - viewport.x) / viewport.width) * 100}%;--window-y:${((value.y - viewport.y) / viewport.height) * 100}%;--window-width:${(value.width / viewport.width) * 100}%;--window-height:${(value.height / viewport.height) * 100}%`; }
  function disablesTransition(id: string) { if (dragPreview?.windowId === id) return dragPreview.phase !== "settling"; return drag?.windowId === id; }
  function isSettling(id: string) { return dragPreview?.windowId === id && dragPreview.phase === "settling"; }
  function select(id: string) { if (!interactive && !selectable) return; onselectwindow?.(id); if (interactive && focusedWindowId !== id) onfocuswindow?.(id); }
  function pointerSelect(event: PointerEvent, id: string) {
    if (event.button !== 0 || (event.target instanceof Element && event.target.closest(".close-window"))) return;
    const element = event.currentTarget;
    if ((interactive || selectable) && element instanceof HTMLElement) element.querySelector<HTMLElement>(".window-titlebar")?.focus({ preventScroll: true });
    select(id);
  }
  function start(event: PointerEvent, window: SurfaceWindow, edge?: ResizeEdge) {
    if (!interactive || event.button !== 0 || drag || dragPreview || (edge ? !allowResize : !allowMove)) return;
    const target = event.target;
    const element = event.currentTarget;
    if (!(target instanceof Element) || (!edge && !target.closest(".window-titlebar")) || !(element instanceof HTMLElement)) return;
    const surface = element.closest(".display-surface");
    if (!(surface instanceof HTMLElement)) return;
    drag = createDrag(event, window, element, surface.getBoundingClientRect(), edge);
    element.setPointerCapture(event.pointerId);
    if (drag.capture) emitPreview(drag, "pressed");
    event.preventDefault();
  }
  function createDrag(event: PointerEvent, window: SurfaceWindow, target: HTMLElement, bounds: SurfaceBounds, edge?: ResizeEdge): Drag {
    const capture = edge ? undefined : createWindowDragCapture(window.id, window.frame, event.clientX, event.clientY, event.timeStamp, bounds, viewport);
    return { pointerId: event.pointerId, windowId: window.id, startClientX: event.clientX, startClientY: event.clientY, startX: window.frame.x, startY: window.frame.y, startFrame: { ...window.frame }, edge, width: window.frame.width, height: window.frame.height, x: window.frame.x, y: window.frame.y, surfaceWidth: bounds.width, surfaceHeight: bounds.height, bounds, target, capture, committing: false, pointer: capture?.start ?? { x: 0, y: 0 } };
  }
  function move(event: PointerEvent) {
    const current = drag;
    if (!current || current.pointerId !== event.pointerId || current.committing) return;
    const dx = ((event.clientX - current.startClientX) / current.surfaceWidth) * viewport.width;
    const dy = ((event.clientY - current.startClientY) / current.surfaceHeight) * viewport.height;
    if (current.edge) Object.assign(current, resizeFrame(current.startFrame, current.edge, dx, dy));
    else moveWindowDrag(current, event, dx, dy);
  }
  function moveWindowDrag(current: Drag, event: PointerEvent, dx: number, dy: number) {
    current.x = current.startX + dx;
    current.y = current.startY + dy;
    current.pointer = updateWindowDragCapture(current.capture!, event.clientX, event.clientY, event.timeStamp, current.bounds, viewport);
    emitPreview(current, "dragging");
  }
  function emitPreview(value: Drag, phase: SurfaceDragPreview["phase"]) { onpreviewdrag?.({ windowId: value.windowId, frame: { x: value.x, y: value.y, width: value.width, height: value.height }, pointer: value.pointer, phase }); }
  function cancelDrag() { const canceled = drag; if (!canceled || canceled.committing) return; drag = null; if (canceled.capture) { cancelWindowDragCapture(canceled.capture); onpreviewdrag?.(null); } if (canceled.target.hasPointerCapture(canceled.pointerId)) canceled.target.releasePointerCapture(canceled.pointerId); }
  function lostCapture(event: PointerEvent) { if (drag?.pointerId === event.pointerId && !drag.committing) cancelDrag(); }
  async function finish(event: PointerEvent, commit: boolean) {
    if (!drag || drag.pointerId !== event.pointerId || drag.committing) return;
    if (!commit) { cancelDrag(); return; }
    move(event);
    const completed = drag;
    if (completed.edge) await finishResize(completed, event);
    else await finishMove(completed);
  }
  async function finishResize(completed: Drag, event: PointerEvent) {
    const moved = Math.hypot(event.clientX - completed.startClientX, event.clientY - completed.startClientY) >= 3;
    if (!moved) { drag = null; return; }
    try { await onresizewindow?.(completed.windowId, { x: completed.x, y: completed.y, width: completed.width, height: completed.height }); }
    finally { if (drag === completed) drag = null; }
  }
  async function finishMove(completed: Drag) {
    const gesture = finishWindowDragCapture(completed.capture!);
    if (!gesture) { drag = null; onpreviewdrag?.(null); return; }
    completed.committing = true;
    emitPreview(completed, "released");
    try { if (ondragwindow) await ondragwindow(gesture); else await onmovewindow?.(completed.windowId, { x: completed.x, y: completed.y }); }
    catch { /* The owning callback reports commit failures. */ }
    finally { onpreviewdrag?.(null); if (drag === completed) drag = null; }
  }
</script>

<div class="display-surface" class:motion>
  {#each windows as window (window.id)}
    {@const content = contentForWindow?.(window)}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="managed-window" class:focused={focusedWindowId === window.id} class:dragging={disablesTransition(window.id)} class:settling={isSettling(window.id)} class:movable={interactive && allowMove} style={styleFor(window)} style:z-index={focusedWindowId === window.id ? windowStack.length + 1 : windowStack.indexOf(window.id) + 1} role="group" aria-label={`${window.title} window`} data-window-id={window.id} onpointerdowncapture={(event) => pointerSelect(event, window.id)}>
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
       <div class="window-titlebar" role="toolbar" aria-label={`${window.title} window title bar`} tabindex={interactive || selectable ? 0 : -1} onkeydown={(event) => { if (!event.defaultPrevented && event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); select(window.id); } }} onpointerdown={(event) => start(event, window)} onpointermove={move} onpointerup={(event) => finish(event, true)} onpointercancel={(event) => finish(event, false)} onlostpointercapture={lostCapture}>
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
  .managed-window:not(.focused) { background: var(--color-screen-background); }
  .motion .managed-window { transition: transform var(--motion-window) var(--easing-layout), inset var(--motion-window) var(--easing-layout), width var(--motion-window) var(--easing-layout), height var(--motion-window) var(--easing-layout), border-color var(--motion-feedback) var(--easing-standard), background var(--motion-feedback) var(--easing-standard); }
  .motion .managed-window.settling { transition: inset 400ms cubic-bezier(.22,1.18,.36,1), width 400ms cubic-bezier(.22,1.18,.36,1), height 400ms cubic-bezier(.22,1.18,.36,1); }
  .managed-window.focused { z-index: 1; border-width: var(--stroke-strong); border-color: var(--color-window-focus); } .managed-window.dragging { transition: none; }
  .resize-handle { position: absolute; touch-action: none; user-select: none; z-index: 1; } .resize-n,.resize-s { left: 8px; right: 8px; height: 5px; cursor: ns-resize; } .resize-e,.resize-w { top: 8px; bottom: 8px; width: 5px; cursor: ew-resize; } .resize-n,.resize-ne,.resize-nw { top: 0; } .resize-s,.resize-se,.resize-sw { bottom: 0; } .resize-e,.resize-ne,.resize-se { right: 0; } .resize-w,.resize-nw,.resize-sw { left: 0; } .resize-ne,.resize-nw,.resize-se,.resize-sw { width: 8px; height: 8px; z-index: 2; } .resize-ne,.resize-sw { cursor: nesw-resize; } .resize-nw,.resize-se { cursor: nwse-resize; }
  .close-window:focus-visible { outline: var(--stroke-strong) solid var(--color-focus-ring); outline-offset: calc(-1 * var(--stroke-strong)); } .close-window { position: relative; z-index: 3; }
   .window-titlebar { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; flex: 0 0 auto; height: var(--window-titlebar-height); min-height: var(--window-titlebar-height); padding-inline: var(--window-titlebar-padding); background: var(--color-window-titlebar-background); font-size: var(--type-screen-label); font-weight: var(--type-weight-medium); line-height: 1; letter-spacing: var(--type-tracking-label); text-transform: lowercase; touch-action: none; user-select: none; } .movable .window-titlebar { cursor: grab; } .dragging .window-titlebar { cursor: grabbing; }
  .traffic { display: flex; align-items: center; gap: var(--window-control-gap); line-height: 1; } .traffic i,.traffic button { display: block; flex: none; width: var(--window-control-size); aspect-ratio: 1; border: 0; border-radius: 50%; margin: 0; padding: 0; background: var(--color-control-close); color: inherit; font: inherit; appearance: none; -webkit-appearance: none; } .traffic button:not(:disabled) { cursor: pointer; } .traffic i:nth-child(2) { background: var(--color-control-minimize); } .traffic i:nth-child(3) { background: var(--color-control-maximize); }
  .managed-window:not(.focused) .traffic :is(i, button) { background: var(--rp-subtle); }
  .app-glyph { display: grid; flex: 1; place-items: center; color: var(--color-page-secondary); font: var(--type-weight-strong) var(--type-app-glyph)/1 var(--type-family-system); }
  @media (prefers-reduced-motion: reduce) { .motion .managed-window, .motion .managed-window.settling { transition-duration: 0ms; } }
</style>
