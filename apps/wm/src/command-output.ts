import { Schema } from "effect";
import {
  CommandResult,
  type StateSnapshot,
  type WindowIdentity,
  type WindowListing,
  type WorkspaceSnapshot,
  type WireResponse,
} from "@paneform/layout";
import type { ErrorReport, PermissionReport } from "./permissions.ts";

const windowLabel = (window: WindowIdentity) => ({
  title: window.title ?? null,
  appName: window.appName ?? null,
});
const windowRow = (window: WindowListing) => ({
  id: window.id,
  ...windowLabel(window),
  assignedWorkspace: window.workspace ?? null,
});
const workspaceRow = (workspace: WorkspaceSnapshot) => ({
  name: workspace.name,
  assignedDisplay: workspace.pinnedDisplayOverride ?? workspace.preferredDisplay,
  currentDisplay: workspace.visibleOnDisplay,
  windows: (
    workspace.windows ?? [...workspace.members, ...workspace.floating].map((id) => ({ id }))
  ).map(windowLabel),
});
const stateSummary = (snapshot: StateSnapshot) => ({
  paused: snapshot.paused,
  health: snapshot.health,
  currentWorkspace: snapshot.focusedWorkspace,
  focusedWindow: snapshot.focusedWindow ?? null,
  windowCount: snapshot.windows.length,
  workspaceCount: snapshot.workspaces.length,
  displayCount: snapshot.topology.length,
});

/** Presentation only: the daemon and engine retain their detailed result contracts. */
export function compactCommandResult(result: CommandResult) {
  switch (result.type) {
    case "windows":
      return {
        currentWorkspace: result.currentWorkspace ?? null,
        windows: result.windows.map(windowRow),
      };
    case "window":
      return {
        currentWorkspace: result.currentWorkspace ?? null,
        window: result.window === null ? null : windowRow(result.window),
      };
    case "workspaces":
      return { workspaces: result.workspaces.map(workspaceRow) };
    case "displays":
      return {
        displays: result.displays.map((display) => ({
          id: display.id,
          primary: display.primary,
          frame: display.frame,
        })),
      };
    case "state":
      return stateSummary(result.snapshot);
    case "ok":
      return { ok: true };
    case "configChecked":
      return result.issues.length
        ? { valid: result.valid, issues: result.issues }
        : { valid: result.valid };
    case "transaction":
      return { status: result.status, appliedSteps: result.appliedSteps };
    case "subscribed":
      return { topics: result.topics };
    case "windowLimitsProbe":
      return result;
  }
  return result satisfies never;
}

/** --verbose preserves the full response, including the transport envelope. */
export function commandOutput(response: WireResponse, verbose = false) {
  if (verbose) return response;
  if (!response.ok) return { ok: false, error: response.error };
  return compactCommandResult(Schema.decodeUnknownSync(CommandResult)(response.data));
}

export function permissionOutput(report: PermissionReport | ErrorReport, verbose = false) {
  if (verbose) return report;
  if ("error" in report) return { ok: false, error: report.error };
  const summary = { ok: report.ok, permissions: report.permissions };
  return report.guidance.length ? { ...summary, guidance: report.guidance } : summary;
}
