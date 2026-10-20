import type { Command, ServiceAction } from "@paneform/layout";
import type { LocalCommand } from "../../../../wm/src/cli-args.js";
import type { ScenarioFile } from "./scenario-files.js";

export type DemoCommandId =
  | Command["type"]
  | `service/${ServiceAction}`
  | `diagnostics/${LocalCommand}`;
export interface ScenarioDescriptor {
  file: ScenarioFile;
  slug: string;
  title: string;
  intro: string;
}
export type CommandDemo =
  | { kind: "desktop"; situations: readonly [ScenarioDescriptor, ...ScenarioDescriptor[]] }
  | { kind: "unavailable"; reason: string };
export type CommandDemoManifest = { readonly [Id in DemoCommandId]: CommandDemo };

const one = (file: ScenarioFile, title: string, intro: string, slug = "example") => ({
  kind: "desktop" as const,
  situations: [{ file, slug, title, intro }] as const,
});

/** Engine identities, rather than page spellings, make this exhaustive and keep aliases grouped. */
export const demoManifest = {
  moveDirection: {
    kind: "desktop",
    situations: [
      {
        file: "move-swap.json",
        slug: "neighbor",
        title: "Borders two windows",
        intro: "Two stacked windows border the focused window on the left.",
      },
      {
        file: "move-shared-edge.json",
        slug: "shared-edge",
        title: "Shared edge",
        intro: "A window above shares the focused window’s left edge.",
      },
      {
        file: "move-exclusive-edge.json",
        slug: "exclusive-edge",
        title: "Exclusive edge",
        intro: "The focused window is alone at the left edge.",
      },
      {
        file: "move-taller-neighbor.json",
        slug: "taller-neighbor",
        title: "Borders a taller window",
        intro: "A taller window is left; another is above the focused window.",
      },
    ],
  },
  moveWindowToWorkspace: {
    kind: "desktop",
    situations: [
      {
        file: "workspace-empty.json",
        slug: "empty",
        title: "Empty destination",
        intro: "Focused window on workspace 1; workspace 2 is empty.",
      },
      {
        file: "workspace-populated.json",
        slug: "populated",
        title: "Populated destination",
        intro: "The destination workspace already contains a window.",
      },
      {
        file: "move-window-workspace.json",
        slug: "nonfocused",
        title: "Nonfocused window",
        intro: "The left neighbor is assigned; the focused window stays here.",
      },
    ],
  },
  focusWindow: one("focus-window.json", "Focus by ID", "Focus the right-most window by its ID."),
  focusDirection: {
    kind: "desktop",
    situations: [
      {
        file: "focus-direction.json",
        slug: "example",
        title: "Borders a window",
        intro: "The focused window has a neighbor to its left.",
      },
      {
        file: "focus-two-neighbors.json",
        slug: "two-neighbors",
        title: "Borders two windows",
        intro: "Two stacked windows border the focused window on the left.",
      },
      {
        file: "focus-exclusive-edge.json",
        slug: "exclusive-edge",
        title: "Exclusive edge",
        intro: "The focused window is alone at the left edge.",
      },
    ],
  },
  moveWindow: one(
    "move-window.json",
    "Set position",
    "Move the focused floating window to a specific position.",
  ),
  resizeWindow: one(
    "resize-window.json",
    "Set size",
    "Resize the focused floating window without moving it.",
  ),
  setWindowFrame: { kind: "unavailable", reason: "Internal API only; not a public command." },
  floatWindow: {
    kind: "desktop",
    situations: [
      {
        file: "float-toggle-two-floating.json",
        slug: "two-floating",
        title: "Two floating windows",
        intro: "Both windows float; the focused one is toggled.",
      },
      {
        file: "float-toggle-floating-over-tiled.json",
        slug: "floating-over-tiled",
        title: "Floating over tiled",
        intro: "The focused window floats over one tiled window.",
      },
      {
        file: "float-toggle-two-tiled.json",
        slug: "two-tiled",
        title: "Two tiled windows",
        intro: "Both windows are tiled side by side.",
      },
    ],
  },
  tileWindow: one(
    "tile-window.json",
    "Return to tiling",
    "The focused floating window returns to tiling.",
  ),
  manageWindow: one(
    "manage-window.json",
    "Manage window",
    "Bring the focused window under manager control.",
  ),
  unmanageWindow: one(
    "unmanage-window.json",
    "Release window",
    "Release the focused window from window-manager control.",
  ),
  probeWindowLimits: { kind: "unavailable", reason: "Internal API only; not a public command." },
  focusWorkspace: one(
    "focus-workspace.json",
    "Switch workspace",
    "Switch to a workspace containing another window.",
  ),
  moveFocusedWorkspaceToNextDisplay: one(
    "workspace-next-display.json",
    "Next display",
    "Move the focused workspace and its window to the next display.",
  ),
  moveWorkspaceToDisplay: one(
    "workspace-move-display.json",
    "Named display",
    "Move workspace 1 and its window to the specified display.",
  ),
  setWorkspaceMode: one(
    "workspace-mode.json",
    "BSP mode",
    "Change workspace 1 from floating to tiled layout mode.",
  ),
  retile: one("retile.json", "Refit tiles", "Fit two uneven windows into equal-width tiles."),
  reconcile: one(
    "reconcile.json",
    "Settle layout",
    "Observe and refit the focused window to its workspace.",
  ),
  pause: one("pause.json", "Pause", "Pause a running manager; the current layout stays in place."),
  resume: one("resume.json", "Resume", "Resume the manager and refit the focused window."),
  togglePause: one(
    "toggle-pause.json",
    "Toggle pause",
    "Switch the manager from running to paused.",
    "toggle",
  ),
  reloadConfig: one(
    "reload-config.json",
    "Reload",
    "Reload the scenario’s in-memory configuration.",
  ),
  validateConfig: one(
    "validate-config.json",
    "Validate",
    "Validate the config without rearranging the focused window.",
  ),
  getState: one(
    "get-state.json",
    "Read state",
    "Read the committed state without changing the desktop.",
  ),
  getWindows: one(
    "get-windows.json",
    "List windows",
    "Read the observed windows without changing their geometry.",
  ),
  getWindow: one(
    "get-window.json",
    "Observe one window",
    "Read the focused window’s observation by ID.",
  ),
  getDisplays: one(
    "get-displays.json",
    "List displays",
    "Read the connected display; the layout stays unchanged.",
  ),
  getWorkspaces: one(
    "get-workspaces.json",
    "List workspaces",
    "Read workspace membership without switching the view.",
  ),
  getTransaction: {
    kind: "unavailable",
    reason: "Transport-only transaction lookup has no CLI/scenario spelling.",
  },
  subscribe: {
    kind: "unavailable",
    reason: "Subscriptions require a live transport and are unsupported by the scenario runner.",
  },
  "service/start": one(
    "service-start.json",
    "Start manager",
    "Start the manager and tile the focused window.",
  ),
  "service/stop": one("service-stop.json", "Stop manager", "Stop the simulated manager."),
  "service/restart": one(
    "service-restart.json",
    "Restart manager",
    "Restart the manager and refit the focused window.",
  ),
  "service/install": {
    kind: "unavailable",
    reason: "Registers a native launchd service; the browser cannot perform installation.",
  },
  "service/status": {
    kind: "unavailable",
    reason:
      "Reports native service status; the simulator only models whether its engine is running.",
  },
  "service/uninstall": {
    kind: "unavailable",
    reason: "Unregisters a native launchd service; the browser cannot perform uninstallation.",
  },
  "diagnostics/permissions": {
    kind: "unavailable",
    reason:
      "Checks actual macOS permissions locally; its docs page uses an illustrative terminal transcript instead.",
  },
  "diagnostics/permissions-request": {
    kind: "unavailable",
    reason: "Opens actual macOS permission prompts; the browser cannot request native permissions.",
  },
} as const satisfies CommandDemoManifest;
