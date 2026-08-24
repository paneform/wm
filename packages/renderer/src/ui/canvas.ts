import type { BspTreeSnapshot, DisplayObservation, Frame, StateSnapshot } from "@wm/engine";

// Default BSP gap — domain-schema.md numeric constant (not exported by the
// engine's frozen public API surface, mirrored here for visualization only).
const BSP_DEFAULT_GAP = 8;

// Canvas visualization — docs/rewrite/web-renderer.md §UI sketch.
// Pseudo-displays at canonical positions (negative origins welcome), work-area
// insets, workspace badges, BSP split lines, window frames colored by state,
// parked slivers at corners. All geometry math here is PURE and DOM-free;
// only drawScene touches a rendering context. The scene redraws ONLY when the
// committed-state epoch changes (see main.ts subscription).

// ---------------------------------------------------------------------------
// Viewport transforms (pure)
// ---------------------------------------------------------------------------

export interface Viewport {
  /** World coordinate at the viewport's top-left corner. */
  x: number;
  y: number;
  scale: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export const worldToScreen = (vp: Viewport, wx: number, wy: number): ScreenPoint => ({
  x: (wx - vp.x) * vp.scale,
  y: (wy - vp.y) * vp.scale,
});

export const screenToWorld = (vp: Viewport, sx: number, sy: number): ScreenPoint => ({
  x: sx / vp.scale + vp.x,
  y: sy / vp.scale + vp.y,
});

export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const worldRectToScreen = (vp: Viewport, frame: Frame): ScreenRect => {
  const tl = worldToScreen(vp, frame.x, frame.y);
  return {
    x: tl.x,
    y: tl.y,
    width: frame.width * vp.scale,
    height: frame.height * vp.scale,
  };
};

/** Pan by screen-space deltas (drag gestures). */
export const panBy = (vp: Viewport, dxScreen: number, dyScreen: number): Viewport => ({
  ...vp,
  x: vp.x - dxScreen / vp.scale,
  y: vp.y - dyScreen / vp.scale,
});

/** Zoom keeping the world point under the screen anchor fixed. */
export const zoomAt = (vp: Viewport, factor: number, axScreen: number, ayScreen: number): Viewport => {
  const nextScale = Math.min(8, Math.max(0.02, vp.scale * factor));
  const anchorWorldBefore = screenToWorld(vp, axScreen, ayScreen);
  return {
    scale: nextScale,
    x: anchorWorldBefore.x - axScreen / nextScale,
    y: anchorWorldBefore.y - ayScreen / nextScale,
  };
};

/** Union bounds of frames (empty ⇒ unit square at origin). */
export function unionFrames(frames: readonly Frame[]): Frame {
  if (frames.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const f of frames) {
    minX = Math.min(minX, f.x);
    minY = Math.min(minY, f.y);
    maxX = Math.max(maxX, f.x + f.width);
    maxY = Math.max(maxY, f.y + f.height);
  }
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/** Fit a world bounds rect into a screen area with padding, centered. */
export function fitViewport(
  bounds: Frame,
  screenWidth: number,
  screenHeight: number,
  padding = 40,
): Viewport {
  const usableW = Math.max(1, screenWidth - padding * 2);
  const usableH = Math.max(1, screenHeight - padding * 2);
  const scale = Math.min(usableW / bounds.width, usableH / bounds.height);
  const centeredX = bounds.x + bounds.width / 2 - screenWidth / (2 * scale);
  const centeredY = bounds.y + bounds.height / 2 - screenHeight / (2 * scale);
  return { x: centeredX, y: centeredY, scale };
}

// ---------------------------------------------------------------------------
// Scene building (pure, from committed StateSnapshot)
// ---------------------------------------------------------------------------

export type WindowVisualState =
  | "managed"
  | "floating"
  | "parked"
  | "quarantined"
  | "ignored";

export interface SceneWindow {
  id: string;
  title?: string | undefined;
  frame: Frame;
  state: WindowVisualState;
  classification: string;
  workspace: string | null;
}

export interface SceneBadge {
  workspace: string;
  mode: string;
  focused: boolean;
  origin: ScreenPoint;
}

export interface SceneSplitLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface SceneDisplay {
  id: string;
  frame: Frame;
  workArea: Frame;
  primary: boolean;
}

export interface Scene {
  displays: readonly SceneDisplay[];
  windows: readonly SceneWindow[];
  badges: readonly SceneBadge[];
  splitLines: readonly SceneSplitLine[];
  focusedWindowId: string | null;
}

export interface SceneExtras {
  focusedWindowId?: string | null | undefined;
}

/** Visual-state classification from the committed projection. */
export function windowVisualState(window: StateSnapshot["windows"][number]): WindowVisualState {
  if (window.parked) return "parked";
  if (!window.managed) {
    return window.classification === "normal" ? "quarantined" : "ignored";
  }
  return window.floating ? "floating" : "managed";
}

/**
 * BSP divider segments for one workspace over its display content rect.
 * Mirrors the documented split math (first pane = floor(available · ratio),
 * second pane offset += gap) WITHOUT constraints — the renderer cannot see
 * learned bounds through the frozen public API, so visuals use plain ratios.
 */
export function splitLinesForTree(
  tree: BspTreeSnapshot,
  content: Frame,
  gap: number = BSP_DEFAULT_GAP,
): SceneSplitLine[] {
  const lines: SceneSplitLine[] = [];
  const walk = (node: BspTreeSnapshot, rect: Frame): void => {
    if (node.kind !== "split") return;
    if (node.axis === "vertical") {
      const firstLen = Math.max(0, Math.floor(rect.width * node.ratio));
      const dividerX = rect.x + firstLen + gap / 2;
      lines.push({ x1: dividerX, y1: rect.y, x2: dividerX, y2: rect.y + rect.height });
      walk(node.first, { ...rect, width: firstLen });
      walk(node.second, { ...rect, x: rect.x + firstLen + gap, width: Math.max(0, rect.width - firstLen - gap) });
    } else {
      const firstLen = Math.max(0, Math.floor(rect.height * node.ratio));
      const dividerY = rect.y + firstLen + gap / 2;
      lines.push({ x1: rect.x, y1: dividerY, x2: rect.x + rect.width, y2: dividerY });
      walk(node.first, { ...rect, height: firstLen });
      walk(node.second, { ...rect, y: rect.y + firstLen + gap, height: Math.max(0, rect.height - firstLen - gap) });
    }
  };
  walk(tree, content);
  return lines;
}

export function buildScene(
  snapshot: StateSnapshot,
  extras: SceneExtras = {},
): Scene {
  const displays: SceneDisplay[] = snapshot.topology.map((d) => ({
    id: d.id,
    frame: d.frame,
    workArea: d.workArea,
    primary: d.primary,
  }));

  const windows: SceneWindow[] = snapshot.windows.map((w) => ({
    id: w.id,
    ...(w.title !== undefined ? { title: w.title } : {}),
    frame: w.frame,
    state: windowVisualState(w),
    classification: w.classification,
    workspace: w.workspace,
  }));

  const badges: SceneBadge[] = [];
  const splitLines: SceneSplitLine[] = [];
  for (const ws of snapshot.workspaces) {
    if (ws.visibleOnDisplay === null) continue;
    const host = displays.find((d) => d.id === ws.visibleOnDisplay);
    if (host === undefined) continue;
    const hasMembers = ws.members.length > 0 || ws.floating.length > 0;
    if (!hasMembers && ws.name !== snapshot.focusedWorkspace) continue;
    badges.push({
      workspace: ws.name,
      mode: ws.mode,
      focused: ws.name === snapshot.focusedWorkspace,
      origin: { x: host.workArea.x + 10, y: host.workArea.y + 18 },
    });
    if (ws.mode === "bsp" && ws.members.length > 0) {
      splitLines.push(...splitLinesForTree(ws.tree, host.workArea));
    }
  }

  void extras;
  return { displays, windows, badges, splitLines, focusedWindowId: extras.focusedWindowId ?? null };
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export const STATE_COLORS: Record<WindowVisualState, string> = {
  managed: "#4da3ff",
  floating: "#ffb84d",
  parked: "#b07cff",
  quarantined: "#ff5d5d",
  ignored: "#6b7280",
};

export const STATE_DASHED: Record<WindowVisualState, boolean> = {
  managed: false,
  floating: false,
  parked: true,
  quarantined: true,
  ignored: true,
};

// ---------------------------------------------------------------------------
// Drawing (the ONLY DOM-touching code in this module)
// ---------------------------------------------------------------------------

export interface DrawOptions {
  selectedWindowId?: string | null | undefined;
  showWorkAreas?: boolean | undefined;
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  vp: Viewport,
  options: DrawOptions = {},
): void {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.fillStyle = "#10131a";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Displays: bordered rects at canonical positions (negative origins fine).
  for (const display of scene.displays) {
    const r = worldRectToScreen(vp, display.frame);
    ctx.fillStyle = "#171c26";
    ctx.fillRect(r.x, r.y, r.width, r.height);
    ctx.strokeStyle = display.primary ? "#7dd3fc" : "#475569";
    ctx.lineWidth = display.primary ? 2 : 1.5;
    ctx.strokeRect(r.x, r.y, r.width, r.height);

    if (options.showWorkAreas !== false) {
      const wa = worldRectToScreen(vp, display.workArea);
      ctx.strokeStyle = "rgba(125, 211, 252, 0.35)";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(wa.x, wa.y, wa.width, wa.height);
      ctx.setLineDash([]);
    }

    // Display label.
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px ui-monospace, monospace";
    ctx.fillText(
      `${display.id.replace("display:sim-", "")}${display.primary ? " (primary)" : ""}`,
      r.x + 6,
      r.y + 14,
    );
  }

  // BSP split lines.
  ctx.strokeStyle = "rgba(96, 165, 250, 0.45)";
  ctx.lineWidth = 1;
  for (const line of scene.splitLines) {
    const a = worldToScreen(vp, line.x1, line.y1);
    const b = worldToScreen(vp, line.x2, line.y2);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  // Window frames, colored by state; parked windows render as corner slivers.
  for (const win of orderedWindows(scene)) {
    const r = worldRectToScreen(vp, win.frame);
    const color = STATE_COLORS[win.state];
    const dashed = STATE_DASHED[win.state];
    const selected = options.selectedWindowId === win.id;

    // Slivers can be sub-pixel wide; guarantee visibility.
    const drawW = Math.max(r.width, win.state === "parked" ? 4 : 1);
    const drawH = Math.max(r.height, win.state === "parked" ? 4 : 1);

    ctx.globalAlpha = win.state === "ignored" ? 0.5 : 0.9;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.16;
    ctx.fillRect(r.x, r.y, drawW, drawH);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 2.5 : 1.25;
    if (dashed) ctx.setLineDash([5, 3]);
    ctx.strokeRect(r.x, r.y, drawW, drawH);
    ctx.setLineDash([]);

    // Focused marker (engine-committed focus from the sim inventory).
    if (scene.focusedWindowId === win.id) {
      ctx.strokeStyle = "#f8fafc";
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x - 3, r.y - 3, drawW + 6, drawH + 6);
    }

    // Label when there is room.
    if (drawW > 90 && drawH > 26) {
      ctx.fillStyle = color;
      ctx.font = "10px ui-monospace, monospace";
      const shortId = win.id.replace("window:sim:", "#");
      ctx.fillText(`${shortId} ${win.state}`, r.x + 5, r.y + 12);
      if (win.title !== undefined && drawH > 40) {
        ctx.fillStyle = "rgba(226, 232, 240, 0.75)";
        ctx.fillText(win.title.slice(0, 28), r.x + 5, r.y + 24);
      }
    }
  }

  // Workspace badges on top.
  for (const badge of scene.badges) {
    const p = worldToScreen(vp, badge.origin.x, badge.origin.y);
    ctx.font = "bold 12px ui-monospace, monospace";
    ctx.fillStyle = badge.focused ? "#a5f3fc" : "#64748b";
    ctx.fillText(`WS ${badge.workspace} · ${badge.mode}${badge.focused ? " ●" : ""}`, p.x, p.y);
  }
}

/** Draw order: bigger frames last so slivers stay visible on top. */
function orderedWindows(scene: Scene): readonly SceneWindow[] {
  return [...scene.windows].sort((a, b) => area(b.frame) - area(a.frame));
}

const area = (f: Frame): number => f.width * f.height;

/** Topmost window whose frame contains the world point (hit testing). */
export function hitTestWindow(
  scene: Scene,
  worldPoint: ScreenPoint,
): string | null {
  const hits = scene.windows.filter((w) =>
    worldPoint.x >= w.frame.x &&
    worldPoint.x < w.frame.x + w.frame.width &&
    worldPoint.y >= w.frame.y &&
    worldPoint.y < w.frame.y + w.frame.height,
  );
  if (hits.length === 0) return null;
  hits.sort((a, b) => area(a.frame) - area(b.frame));
  return hits[0]?.id ?? null;
}
