import swap from "./demos/move-swap.json";
import shared from "./demos/move-shared-edge.json";
import exclusive from "./demos/move-exclusive-edge.json";
import tallerNeighbor from "./demos/move-taller-neighbor.json";
import empty from "./demos/workspace-empty.json";
import populated from "./demos/workspace-populated.json";
import explicitWorkspace from "./demos/move-window-workspace.json";
import focus from "./demos/focus-window.json";
import focusDirection from "./demos/focus-direction.json";
import focusTwoNeighbors from "./demos/focus-two-neighbors.json";
import focusExclusiveEdge from "./demos/focus-exclusive-edge.json";
import move from "./demos/move-window.json";
import resize from "./demos/resize-window.json";
import float from "./demos/float-window.json";
import tile from "./demos/tile-window.json";
import manage from "./demos/manage-window.json";
import unmanage from "./demos/unmanage-window.json";
import workspaceFocus from "./demos/focus-workspace.json";
import nextDisplay from "./demos/workspace-next-display.json";
import moveDisplay from "./demos/workspace-move-display.json";
import mode from "./demos/workspace-mode.json";
import retile from "./demos/retile.json";
import reconcile from "./demos/reconcile.json";
import pause from "./demos/pause.json";
import resume from "./demos/resume.json";
import togglePause from "./demos/toggle-pause.json";
import reload from "./demos/reload-config.json";
import validate from "./demos/validate-config.json";
import state from "./demos/get-state.json";
import windows from "./demos/get-windows.json";
import window from "./demos/get-window.json";
import displays from "./demos/get-displays.json";
import workspaces from "./demos/get-workspaces.json";
import start from "./demos/service-start.json";
import stop from "./demos/service-stop.json";
import restart from "./demos/service-restart.json";

/** Explicit imports make missing files a compiler error, and preserve literal file IDs. */
export const scenarioFiles = {
  "move-swap.json": swap,
  "move-shared-edge.json": shared,
  "move-exclusive-edge.json": exclusive,
  "move-taller-neighbor.json": tallerNeighbor,
  "workspace-empty.json": empty,
  "workspace-populated.json": populated,
  "move-window-workspace.json": explicitWorkspace,
  "focus-window.json": focus,
  "focus-direction.json": focusDirection,
  "focus-two-neighbors.json": focusTwoNeighbors,
  "focus-exclusive-edge.json": focusExclusiveEdge,
  "move-window.json": move,
  "resize-window.json": resize,
  "float-window.json": float,
  "tile-window.json": tile,
  "manage-window.json": manage,
  "unmanage-window.json": unmanage,
  "focus-workspace.json": workspaceFocus,
  "workspace-next-display.json": nextDisplay,
  "workspace-move-display.json": moveDisplay,
  "workspace-mode.json": mode,
  "retile.json": retile,
  "reconcile.json": reconcile,
  "pause.json": pause,
  "resume.json": resume,
  "toggle-pause.json": togglePause,
  "reload-config.json": reload,
  "validate-config.json": validate,
  "get-state.json": state,
  "get-windows.json": windows,
  "get-window.json": window,
  "get-displays.json": displays,
  "get-workspaces.json": workspaces,
  "service-start.json": start,
  "service-stop.json": stop,
  "service-restart.json": restart,
};
export type ScenarioFile = keyof typeof scenarioFiles;
