import type {
  Capabilities,
  Constraints,
  DisplayId,
  Frame,
  TopologyObservation,
  WindowClass,
  WindowId,
  WindowObservation,
  WorkspaceName,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Layout trees
// ---------------------------------------------------------------------------

export type SplitAxis = "vertical" | "horizontal";

export type BspNode =
  | { kind: "leaf"; windowId: WindowId }
  | { kind: "split"; axis: SplitAxis; ratio: number; first: BspNode; second: BspNode };

/** In-order leaf ids of a tree. */
export function bspLeaves(node: BspNode): WindowId[] {
  return node.kind === "leaf"
    ? [node.windowId]
    : [...bspLeaves(node.first), ...bspLeaves(node.second)];
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export type WorkspaceMode = "bsp" | "floating";

export interface WorkspaceState {
  name: WorkspaceName;
  mode: WorkspaceMode;
  tree: BspNode;
  floating: ReadonlySet<WindowId>;
  /** Display currently showing this workspace (visible), if any. */
  visibleOnDisplay: DisplayId | null;
  /** Preferred display affinity from config. */
  preferredDisplay: DisplayId | null;
  /** Explicit user move override; persists until reset. */
  pinnedDisplayOverride: DisplayId | null;
  /** Durable parked intent per window — never inferred from coordinates. */
  parkedFrames: ReadonlyMap<WindowId, Frame>;
  /** Most-recently focused member, for split-target selection. */
  lastFocusedMember: WindowId | null;
}

// ---------------------------------------------------------------------------
// Learned profiles & parking facts
// ---------------------------------------------------------------------------

export type Confidence = "tentative" | "learned" | "strong";

export interface ProfileKey {
  /** bundleId ?? executablePath; profile absent when neither exists. */
  application: string;
  role: string;
  subrole?: string;
  contextFingerprint: string;
}

export interface Profile {
  key: ProfileKey;
  constraints: Constraints;
  sampleCount: number;
  confidence: Confidence;
  correctiveAttemptCount: number;
  cooperative: boolean;
}

export interface ParkingVisibility {
  horizontal: number;
  vertical: number;
}

export type ParkingCorner = "bottomLeft" | "bottomRight" | "topLeft" | "topRight";

export interface ParkingFact {
  displayId: DisplayId;
  corner: ParkingCorner;
  visibility: ParkingVisibility;
  /** Fingerprint of THIS display's own geometry + OS version. Neighbors excluded. */
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export interface World {
  topology: TopologyObservation;
  windows: ReadonlyMap<WindowId, WindowObservation>;
  workspaces: ReadonlyMap<WorkspaceName, WorkspaceState>;
  focusedWorkspace: WorkspaceName | null;
  profiles: ReadonlyMap<string, Profile>;
  parkingFacts: readonly ParkingFact[];
  paused: boolean;
  epoch: number;
  /**
   * Engine-issued window-focus intent with a monotonic generation. It
   * survives stale observation snapshots/reconciles until an authoritative
   * newer platform focus event supersedes it or the window dies.
   */
  focusIntent: { id: WindowId; generation: number } | null;
}

/** Engine classification of a window from its observation attributes. */
export function classify(observation: WindowObservation): WindowClass {
  const systemApps = ["com.apple.controlcenter", "com.apple.dock", "systemuiserver"];
  if (
    observation.bundleId !== undefined &&
    systemApps.some((id) => observation.bundleId!.toLowerCase() === id)
  ) {
    return "system";
  }
  if (observation.role !== "AXWindow") return "uncertain";
  const transientSubroles = ["AXDialog", "AXSheet", "AXSystemDialog", "AXFloatingWindow"];
  if (observation.subrole !== undefined && transientSubroles.includes(observation.subrole)) {
    return "transient";
  }
  return "normal";
}

export function capabilitiesOf(observation: WindowObservation): Capabilities {
  return observation.capabilities;
}
