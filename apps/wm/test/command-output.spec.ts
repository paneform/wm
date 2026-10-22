import { describe, expect, test } from "vitest";
import { makeWindowDiagnostics } from "../../../packages/layout/test/helpers/window-diagnostics.ts";
import type {
  StateSnapshot,
  WindowListing,
  WorkspaceSnapshot,
  WireResponse,
} from "@paneform/layout";
import { commandOutput, permissionOutput } from "../src/command-output.ts";
import { parseArgs } from "../src/cli-args.ts";

const window: WindowListing = {
  id: "window:1",
  title: "Project",
  appName: "Editor",
  pid: 42,
  bundleId: "com.example.editor",
  workspace: "2",
  role: "AXWindow",
  frame: { x: 0, y: 28, width: 700, height: 500 },
  minimized: false,
  hidden: false,
  fullscreen: false,
  focused: false,
  capabilities: {
    movable: "supported",
    resizable: "supported",
    movableEvidence: "platform_report",
    resizableEvidence: "platform_report",
  },
};
const workspace: WorkspaceSnapshot = {
  name: "2",
  mode: "bsp",
  members: [window.id],
  floating: [],
  tree: { kind: "leaf", windowId: window.id },
  visibleOnDisplay: "display:current",
  preferredDisplay: "display:preferred",
  pinnedDisplayOverride: "display:assigned",
  windows: [{ id: window.id, title: window.title, appName: window.appName }],
};
const response = (data: unknown): WireResponse => ({
  v: 1,
  type: "response",
  id: "request:1",
  ok: true,
  data,
});

describe("compact command output", () => {
  test("observe includes query errors and reader privileges even without verbose mode", () => {
    const diagnostics = makeWindowDiagnostics(window.id, window.pid);
    expect(
      commandOutput(response({ type: "window", window, cachedWindow: window, diagnostics })),
    ).toMatchObject({
      window,
      cachedWindow: window,
      diagnostics: {
        observer: { accessibility: true },
        target: { registered: false },
        queries: [{ errorCode: 0 }, { errorCode: -25204, value: null }],
      },
    });
  });
  test("window lists contain identity, assignment and one current workspace", () => {
    expect(
      commandOutput(response({ type: "windows", currentWorkspace: "1", windows: [window] })),
    ).toEqual({
      currentWorkspace: "1",
      windows: [{ id: "window:1", title: "Project", appName: "Editor", assignedWorkspace: "2" }],
    });
  });
  test("missing metadata and unassigned windows remain explicit nulls", () => {
    const { title: _title, appName: _appName, workspace: _workspace, ...unassigned } = window;
    expect(
      commandOutput(response({ type: "windows", currentWorkspace: null, windows: [unassigned] })),
    ).toEqual({
      currentWorkspace: null,
      windows: [{ id: "window:1", title: null, appName: null, assignedWorkspace: null }],
    });
  });
  test("workspace display assignment and current visibility are independent", () => {
    expect(commandOutput(response({ type: "workspaces", workspaces: [workspace] }))).toEqual({
      workspaces: [
        {
          name: "2",
          assignedDisplay: "display:assigned",
          currentDisplay: "display:current",
          windows: [{ title: "Project", appName: "Editor" }],
        },
      ],
    });
    expect(
      commandOutput(
        response({
          type: "workspaces",
          workspaces: [{ ...workspace, pinnedDisplayOverride: null, visibleOnDisplay: null }],
        }),
      ),
    ).toMatchObject({
      workspaces: [{ assignedDisplay: "display:preferred", currentDisplay: null }],
    });
  });
  test("workspace rows with no display affinity report null instead of assuming the current display", () => {
    expect(
      commandOutput(
        response({
          type: "workspaces",
          workspaces: [
            {
              ...workspace,
              pinnedDisplayOverride: null,
              preferredDisplay: null,
              windows: [],
              members: [],
            },
          ],
        }),
      ),
    ).toEqual({
      workspaces: [
        { name: "2", assignedDisplay: null, currentDisplay: "display:current", windows: [] },
      ],
    });
  });
  test("observe preserves detailed facts while mutations omit transaction receipts", () => {
    expect(commandOutput(response({ type: "window", window, currentWorkspace: "1" }))).toEqual({
      currentWorkspace: "1",
      window,
    });
    expect(
      commandOutput(response({ type: "window", window: null, currentWorkspace: "1" })),
    ).toEqual({ currentWorkspace: "1", window: null });
    expect(commandOutput(response({ type: "ok", detail: "cmd:123:receipt" }))).toEqual({
      ok: true,
    });
    expect(commandOutput(response({ type: "configChecked", valid: true, issues: [] }))).toEqual({
      valid: true,
    });
    expect(
      commandOutput(response({ type: "configChecked", valid: false, issues: ["Invalid gap"] })),
    ).toEqual({ valid: false, issues: ["Invalid gap"] });
  });
  test("state defaults to an overview rather than geometry and trees", () => {
    const snapshot: StateSnapshot = {
      epoch: 123,
      paused: false,
      health: "healthy",
      focusedWorkspace: "1",
      focusedWindow: "window:1",
      windows: [],
      workspaces: [workspace],
      topology: [],
      pendingTransactions: [],
    };
    expect(commandOutput(response({ type: "state", snapshot }))).toEqual({
      paused: false,
      health: "healthy",
      currentWorkspace: "1",
      focusedWindow: "window:1",
      windowCount: 0,
      workspaceCount: 1,
      displayCount: 0,
    });
  });
  test("verbose preserves the complete response object and default errors keep actionable details", () => {
    const full = response({ type: "windows", currentWorkspace: "1", windows: [window] });
    expect(commandOutput(full, true)).toBe(full);
    const failure: WireResponse = {
      v: 1,
      type: "response",
      id: "failure",
      ok: false,
      error: { code: "paused", message: "Run wm resume" },
    };
    expect(commandOutput(failure)).toEqual({ ok: false, error: failure.error });
    expect(commandOutput(failure, true)).toBe(failure);
  });
  test("permissions retain readiness and remediation, while verbose retains sidecar diagnostics", () => {
    const report = {
      command: "permissions" as const,
      ok: false,
      permissions: { accessibility: false, screenRecording: true },
      guidance: ["Run wm permissions request"],
      sidecar: { path: "/opt/wm", version: "1" },
    };
    expect(permissionOutput(report)).toEqual({
      ok: false,
      permissions: report.permissions,
      guidance: report.guidance,
    });
    expect(permissionOutput(report, true)).toBe(report);
    expect(permissionOutput({ ...report, ok: true, guidance: [] })).toEqual({
      ok: true,
      permissions: report.permissions,
    });
  });
  test("verbose is accepted globally without modifying the engine command", () => {
    for (const words of [
      ["window", "list"],
      ["workspace", "list"],
      ["config", "validate"],
      ["permissions"],
      ["service", "status"],
    ]) {
      const plain = parseArgs(words);
      const verbose = parseArgs(["--verbose", ...words]);
      expect(verbose.error).toBeNull();
      expect(verbose.flags["verbose"]).toBe(true);
      expect(verbose.command).toEqual(plain.command);
      expect(verbose.localCommand).toBe(plain.localCommand);
      expect(verbose.service).toBe(plain.service);
    }
    expect(parseArgs(["window", "list", "--verbose", "--verbose"]).error).not.toBeNull();
  });
});
