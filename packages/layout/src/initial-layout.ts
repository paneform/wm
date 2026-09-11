import type { DisplayId, Frame, WindowId, WorkspaceName } from "./schema.js";
import type { BspNode, SplitAxis } from "./world.js";
import { ratioForLength } from "./layout/bsp.js";

export type EngineInitialLayout = {
  windows: readonly {
    windowId: string;
    workspace: string | null;
    floating?: boolean;
  }[];
  displays: readonly { displayId: string; workspace: string | null }[];
  focusedWorkspace: string | null;
};

export interface ResolvedInitialWorkspace {
  readonly name: WorkspaceName;
  readonly tree: BspNode | null;
  readonly floating: ReadonlySet<WindowId>;
  readonly visibleOnDisplay: DisplayId | null;
}

interface FramedWindow {
  readonly id: WindowId;
  readonly frame: Frame;
}

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const center = (window: FramedWindow, axis: "x" | "y"): number =>
  axis === "x" ? window.frame.x + window.frame.width / 2 : window.frame.y + window.frame.height / 2;

function boundsOf(windows: readonly FramedWindow[]): Frame {
  const x = Math.min(...windows.map(({ frame }) => frame.x));
  const y = Math.min(...windows.map(({ frame }) => frame.y));
  return {
    x,
    y,
    width: Math.max(...windows.map(({ frame }) => frame.x + frame.width)) - x,
    height: Math.max(...windows.map(({ frame }) => frame.y + frame.height)) - y,
  };
}

interface Partition {
  axis: SplitAxis;
  first: readonly FramedWindow[];
  second: readonly FramedWindow[];
  border: number | null;
}

function separatingPartition(windows: readonly FramedWindow[]): Partition | undefined {
  const candidates: Partition[] = [];
  for (const axis of ["vertical", "horizontal"] as const) {
    const start = axis === "vertical" ? "x" : "y";
    const size = axis === "vertical" ? "width" : "height";
    const ordered = [...windows].sort(
      (a, b) => a.frame[start] - b.frame[start] || compareIds(a.id, b.id),
    );
    let end = ordered[0]!.frame[start] + ordered[0]!.frame[size];
    for (let i = 1; i < ordered.length; i += 1) {
      const next = ordered[i]!.frame;
      if (end <= next[start]) {
        candidates.push({
          axis,
          first: ordered.slice(0, i),
          second: ordered.slice(i),
          border: (end + next[start]) / 2,
        });
      }
      end = Math.max(end, next[start] + next[size]);
    }
  }
  // Balanced *valid* cuts bound depth without cutting through another window.
  candidates.sort(
    (a, b) =>
      Math.abs(a.first.length - a.second.length) - Math.abs(b.first.length - b.second.length),
  );
  return candidates[0];
}

function overlappingPartition(windows: readonly FramedWindow[]): Partition {
  const ordered = [...windows].sort(
    (a, b) =>
      center(a, "x") - center(b, "x") || center(a, "y") - center(b, "y") || compareIds(a.id, b.id),
  );
  const xSpread = center(ordered[ordered.length - 1]!, "x") - center(ordered[0]!, "x");
  const byY = [...windows].sort(
    (a, b) =>
      center(a, "y") - center(b, "y") || center(a, "x") - center(b, "x") || compareIds(a.id, b.id),
  );
  const ySpread = center(byY[byY.length - 1]!, "y") - center(byY[0]!, "y");
  const axis = xSpread >= ySpread ? "vertical" : "horizontal";
  const sorted = axis === "vertical" ? ordered : byY;
  const splitAt = Math.ceil(sorted.length / 2);
  const first = sorted.slice(0, splitAt);
  const second = sorted.slice(splitAt);

  return { axis, first, second, border: null };
}

/** Preserve valid visible borders; overlapping/non-slicing scenes use a deterministic fallback. */
export function inferInitialTree(
  windows: readonly FramedWindow[],
  content?: Frame,
  gap = 0,
): BspNode | null {
  if (windows.length === 0) return null;
  if (windows.length === 1) return { kind: "leaf", windowId: windows[0]!.id };
  const source = boundsOf(windows);
  const target = content ?? source;
  const partition = separatingPartition(windows) ?? overlappingPartition(windows);
  const start = partition.axis === "vertical" ? "x" : "y";
  const size = partition.axis === "vertical" ? "width" : "height";
  let border = partition.border;
  if (
    border !== null &&
    (source[start] >= target[start] + target[size] || source[start] + source[size] <= target[start])
  ) {
    border = target[start] + ((border - source[start]) / source[size]) * target[size];
  }
  // Preserve the divider center when changing gaps, and grow outer panes into
  // unused display space instead of needlessly moving every internal border.
  const usable = Math.max(0, target[size] - gap);
  const firstSize =
    border === null
      ? usable / 2
      : Math.max(1, Math.min(usable - 1, border - target[start] - gap / 2));
  const ratio = usable > 2 ? ratioForLength(firstSize, usable) : 0.5;
  const realizedFirst = Math.floor(usable * ratio);
  const firstFrame = { ...target, [size]: realizedFirst };
  const secondFrame = {
    ...target,
    [start]: target[start] + realizedFirst + gap,
    [size]: Math.max(0, target[size] - realizedFirst - gap),
  };
  return {
    kind: "split",
    axis: partition.axis,
    ratio,
    first: inferInitialTree(partition.first, firstFrame, gap)!,
    second: inferInitialTree(partition.second, secondFrame, gap)!,
  };
}

export function resolveInitialLayout(
  initial: EngineInitialLayout,
  windows: ReadonlyMap<WindowId, Frame>,
  displayIds: ReadonlySet<DisplayId>,
  settingsFor?: (
    name: WorkspaceName,
    displayId: DisplayId | null,
  ) => { content?: Frame | undefined; gap: number },
): readonly ResolvedInitialWorkspace[] {
  const memberships = new Map<WorkspaceName, { tiled: FramedWindow[]; floating: Set<WindowId> }>();
  const seenWindows = new Set<WindowId>();
  for (const entry of initial.windows) {
    if (seenWindows.has(entry.windowId))
      throw new Error(`duplicate initial window: ${entry.windowId}`);
    seenWindows.add(entry.windowId);
    const frame = windows.get(entry.windowId);
    if (frame === undefined) throw new Error(`unknown initial window: ${entry.windowId}`);
    if (entry.workspace === null) continue;
    const members = memberships.get(entry.workspace) ?? { tiled: [], floating: new Set() };
    if (entry.floating === true) members.floating.add(entry.windowId);
    else members.tiled.push({ id: entry.windowId, frame });
    memberships.set(entry.workspace, members);
  }

  const visible = new Map<WorkspaceName, DisplayId>();
  const seenDisplays = new Set<DisplayId>();
  for (const entry of initial.displays) {
    if (seenDisplays.has(entry.displayId))
      throw new Error(`duplicate initial display: ${entry.displayId}`);
    seenDisplays.add(entry.displayId);
    if (!displayIds.has(entry.displayId))
      throw new Error(`unknown initial display: ${entry.displayId}`);
    if (entry.workspace === null) continue;
    if (visible.has(entry.workspace)) {
      throw new Error(`initial workspace assigned to multiple displays: ${entry.workspace}`);
    }
    visible.set(entry.workspace, entry.displayId);
    if (!memberships.has(entry.workspace))
      memberships.set(entry.workspace, { tiled: [], floating: new Set() });
  }

  if (initial.focusedWorkspace !== null && !memberships.has(initial.focusedWorkspace)) {
    throw new Error(`unknown focused initial workspace: ${initial.focusedWorkspace}`);
  }

  return [...memberships].map(([name, members]) => {
    const visibleOnDisplay = visible.get(name) ?? null;
    const settings = settingsFor?.(name, visibleOnDisplay);
    return {
      name,
      tree: inferInitialTree(members.tiled, settings?.content, settings?.gap),
      floating: members.floating,
      visibleOnDisplay,
    };
  });
}
