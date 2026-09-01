import type { PermissionStatus, SettingsTarget } from "@paneform/wm-macos";

/**
 * Local (no-daemon) permission workflows behind `wm doctor` and
 * `wm permissions request`. The client surface is promise-shaped and fully
 * injectable so tests stay headless: no sidecar process, no TCC prompts.
 *
 * Exit semantics follow the daemon contract: Accessibility is REQUIRED
 * (`wm serve` refuses to start without it); Screen Recording may remain
 * degraded and only lowers metadata quality.
 */

export type PermissionCommand = "doctor" | "permissions-request";

export interface ReadyInfo {
  readonly version: string;
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

export interface PermissionClient {
  /** Path the sidecar was spawned from (reported verbatim when known). */
  readonly sidecarPath?: string | undefined;
  /** Resolves once the sidecar handshake arrives. */
  readonly whenReady: Promise<ReadyInfo>;
  permissionsStatus(): Promise<PermissionStatus>;
  requestPermissions(): Promise<PermissionStatus>;
  openSettings(target: SettingsTarget): Promise<void>;
  stop(): void;
}

export interface SidecarMeta {
  readonly path?: string;
  readonly version?: string;
}

export interface PermissionReport {
  readonly command: PermissionCommand;
  readonly ok: boolean;
  readonly sidecar?: SidecarMeta;
  readonly permissions: PermissionStatus;
  readonly guidance: readonly string[];
}

export interface ErrorReport {
  readonly command: PermissionCommand;
  readonly ok: false;
  readonly error: { readonly message: string };
}

const ACCESSIBILITY_GUIDANCE =
  'Accessibility is not granted to wm-sidecar. Run "wm permissions request" and approve the prompt, or add wm-sidecar under System Settings > Privacy & Security > Accessibility.';
const SCREEN_RECORDING_GUIDANCE =
  'Screen Recording is not granted; window titles and off-process app names degrade (the daemon still runs). Optional: run "wm permissions request" or open System Settings > Privacy & Security > Screen Recording.';

export const exitCodeFor = (report: PermissionReport | ErrorReport): number =>
  report.ok ? 0 : 1;

export const buildPermissionReport = (
  command: PermissionCommand,
  permissions: PermissionStatus,
  sidecar?: SidecarMeta,
): PermissionReport => {
  const guidance: string[] = [];
  if (!permissions.accessibility) guidance.push(ACCESSIBILITY_GUIDANCE);
  if (!permissions.screenRecording) guidance.push(SCREEN_RECORDING_GUIDANCE);
  const meta: { path?: string; version?: string } = {};
  if (sidecar?.path !== undefined) meta.path = sidecar.path;
  if (sidecar?.version !== undefined) meta.version = sidecar.version;
  return {
    command,
    ok: permissions.accessibility,
    ...(Object.keys(meta).length > 0 ? { sidecar: meta } : {}),
    permissions: {
      accessibility: permissions.accessibility,
      screenRecording: permissions.screenRecording,
    },
    guidance,
  };
};

export interface PermissionFlowOptions {
  /**
   * After requesting, deep link the System Settings pane for every permission
   * still ungranted (explicit opt-in via --open-settings).
   */
  readonly openSettingsAfterRequest?: boolean;
  /** Bounded wait for the handshake (tests inject a small value). */
  readonly handshakeTimeoutMs?: number;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

const withHandshakeTimeout = async (
  client: PermissionClient,
  timeoutMs: number,
): Promise<ReadyInfo> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      client.whenReady,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`sidecar handshake timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Runs one read-only (`doctor`) or prompting (`permissions request`) pass
 * against the given client. Always stops the client, even on failure; errors
 * propagate to the caller for structured reporting.
 */
export const runPermissionFlow = async (
  command: PermissionCommand,
  client: PermissionClient,
  options: PermissionFlowOptions = {},
): Promise<PermissionReport> => {
  try {
    const ready = await withHandshakeTimeout(
      client,
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
    const permissions =
      command === "permissions-request" ?
        await client.requestPermissions()
      : await client.permissionsStatus();
    if (command === "permissions-request" && options.openSettingsAfterRequest === true) {
      if (!permissions.accessibility) await client.openSettings("accessibility");
      if (!permissions.screenRecording) await client.openSettings("screenRecording");
    }
    return buildPermissionReport(command, permissions, {
      ...(client.sidecarPath !== undefined ? { path: client.sidecarPath } : {}),
      version: ready.version,
    });
  } finally {
    client.stop();
  }
};

export const errorReport = (
  command: PermissionCommand,
  cause: unknown,
): ErrorReport => ({
  command,
  ok: false,
  error: { message: cause instanceof Error ? cause.message : String(cause) },
});
