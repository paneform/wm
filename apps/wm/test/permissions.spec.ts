import { describe, expect, test, vi } from "vitest";
import type { PermissionStatus } from "@paneform/wm-macos";
import { parseArgs } from "../src/cli-args.ts";
import {
  buildPermissionReport,
  errorReport,
  exitCodeFor,
  runPermissionFlow,
  type PermissionClient,
} from "../src/permissions.ts";

const granted: PermissionStatus = { accessibility: true, screenRecording: true };
const degraded: PermissionStatus = { accessibility: true, screenRecording: false };
const denied: PermissionStatus = { accessibility: false, screenRecording: false };

interface FakeClientOptions {
  sidecarPath?: string;
  ready?: { version?: string; accessibility?: boolean; screenRecording?: boolean };
  status?: PermissionStatus;
  requested?: PermissionStatus;
  failRequest?: Error;
}

const makeClient = (options: FakeClientOptions = {}): PermissionClient & {
  stop: ReturnType<typeof vi.fn>;
} => {
  const status = options.status ?? denied;
  const client = {
    sidecarPath: options.sidecarPath ?? "/fake/wm-sidecar",
    whenReady: Promise.resolve({
      version: options.ready?.version ?? "wm-sidecar 0.1.0",
      accessibility: options.ready?.accessibility ?? true,
      screenRecording: options.ready?.screenRecording ?? true,
    }),
    permissionsStatus: vi.fn(async () => status),
    requestPermissions: vi.fn(async () => {
      if (options.failRequest !== undefined) throw options.failRequest;
      return options.requested ?? status;
    }),
    openSettings: vi.fn(async () => {}),
    stop: vi.fn(),
  };
  return client;
};

describe("parseArgs local permission commands", () => {
  test("doctor routes locally without an engine command", () => {
    const parsed = parseArgs(["doctor"]);
    expect(parsed.localCommand).toBe("doctor");
    expect(parsed.command).toBeNull();
    expect(parsed.serve).toBe(false);
  });

  test("permissions request routes locally", () => {
    const parsed = parseArgs(["permissions", "request", "--open-settings"]);
    expect(parsed.localCommand).toBe("permissions-request");
    expect(parsed.command).toBeNull();
    expect(parsed.flags["open-settings"]).toBe(true);
  });

  test("--sidecar captures the executable path", () => {
    const parsed = parseArgs(["doctor", "--sidecar", "/opt/wm/wm-sidecar"]);
    expect(parsed.flags["sidecar"]).toBe("/opt/wm/wm-sidecar");
  });

  test("bare permissions verb is not a local command (usage path)", () => {
    const parsed = parseArgs(["permissions"]);
    expect(parsed.localCommand).toBeNull();
    expect(parsed.command).toBeNull();
  });

  test("daemon verbs are unaffected", () => {
    const parsed = parseArgs(["windows"]);
    expect(parsed.localCommand).toBeNull();
    expect(parsed.command).toEqual({ type: "getWindows" });
  });
});

describe("buildPermissionReport", () => {
  test("fully granted reports ok with no guidance", () => {
    const report = buildPermissionReport("doctor", granted, {
      path: "/fake/wm-sidecar",
      version: "wm-sidecar 0.1.0",
    });
    expect(report.ok).toBe(true);
    expect(report.guidance).toEqual([]);
    expect(report.sidecar).toEqual({ path: "/fake/wm-sidecar", version: "wm-sidecar 0.1.0" });
    expect(exitCodeFor(report)).toBe(0);
  });

  test("missing accessibility fails with concrete remediation", () => {
    const report = buildPermissionReport("permissions-request", denied);
    expect(report.ok).toBe(false);
    expect(exitCodeFor(report)).toBe(1);
    expect(report.guidance.join("\n")).toContain("Accessibility is not granted");
    expect(report.guidance.join("\n")).toContain("System Settings > Privacy & Security > Accessibility");
  });

  test("degraded screen recording alone stays ok but warns", () => {
    const report = buildPermissionReport("doctor", degraded);
    expect(report.ok).toBe(true);
    expect(exitCodeFor(report)).toBe(0);
    expect(report.guidance.join("\n")).toContain("Screen Recording is not granted");
  });
});

describe("runPermissionFlow", () => {
  test("doctor is read-only: queries status and stops the client", async () => {
    const client = makeClient({ status: granted });
    const report = await runPermissionFlow("doctor", client);

    expect(client.permissionsStatus).toHaveBeenCalledOnce();
    expect(client.requestPermissions).not.toHaveBeenCalled();
    expect(client.openSettings).not.toHaveBeenCalled();
    expect(client.stop).toHaveBeenCalledOnce();
    expect(report.command).toBe("doctor");
    expect(report.permissions).toEqual(granted);
    expect(report.sidecar?.path).toBe("/fake/wm-sidecar");
    expect(report.sidecar?.version).toBe("wm-sidecar 0.1.0");
  });

  test("request triggers prompts via the client then reports statuses", async () => {
    const client = makeClient({ status: denied, requested: granted });
    const report = await runPermissionFlow("permissions-request", client);

    expect(client.requestPermissions).toHaveBeenCalledOnce();
    expect(client.permissionsStatus).not.toHaveBeenCalled();
    expect(report.permissions).toEqual(granted);
    expect(report.guidance).toEqual([]);
    expect(client.stop).toHaveBeenCalledOnce();
  });

  test("open-settings opt-in deep links only ungranted panes", async () => {
    const client = makeClient({ status: denied, requested: degraded });
    await runPermissionFlow("permissions-request", client, { openSettingsAfterRequest: true });

    expect(client.openSettings).toHaveBeenCalledOnce();
    expect(client.openSettings).toHaveBeenCalledWith("screenRecording");
  });

  test("stops the client even when the flow rejects", async () => {
    const client = makeClient({
      status: denied,
      failRequest: new Error("sidecar exited"),
    });
    await expect(runPermissionFlow("permissions-request", client)).rejects.toThrow("sidecar exited");
    expect(client.stop).toHaveBeenCalledOnce();
  });

  test("a wedged sidecar (no handshake) fails bounded, not forever", async () => {
    const client = makeClient({ status: denied });
    Object.defineProperty(client, "whenReady", { value: new Promise(() => {}) });
    await expect(
      runPermissionFlow("doctor", client, { handshakeTimeoutMs: 20 }),
    ).rejects.toThrow("sidecar handshake timed out after 20ms");
    expect(client.stop).toHaveBeenCalledOnce();
  });

  test("errors convert to structured reports with exit code 1", () => {
    const report = errorReport("doctor", new Error("spawn failed"));
    expect(exitCodeFor(report)).toBe(1);
    expect(report.error.message).toBe("spawn failed");
  });
});
