import type { WindowDiagnostics } from "../../src/window-inspection.ts";

export const makeWindowDiagnostics = (
  windowId: string | null = "window:1",
  pid = 42,
): WindowDiagnostics => ({
  platform: "macos-ax",
  capturedAt: "2026-10-08T00:00:00Z",
  observer: { pid: 99, bundleId: "com.paneform.wm", accessibility: true, screenRecording: true },
  target: { windowId, pid, registered: false, activationPolicy: null, active: null, hidden: null },
  nsFrontmostPidBefore: 7,
  nsFrontmostPidAfter: 7,
  resolutionError: null,
  queries: [
    {
      scope: "window",
      attribute: "AXFocused",
      errorCode: 0,
      errorName: "success",
      valueType: "boolean",
      value: true,
    },
    {
      scope: "system",
      attribute: "AXFocusedApplication",
      errorCode: -25204,
      errorName: "cannot_complete",
      valueType: "none",
      value: null,
    },
  ],
});
