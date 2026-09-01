import { Either, Effect, Schema, Stream } from "effect";
import type {
  ExpectedWindowIdentity,
  Frame,
  PlatformAdapter,
  PlatformEvent,
  PlatformError,
  Point,
  Size,
  WindowId,
  PlatformBatchRequest,
  PlatformBatchResult,
} from "@paneform/layout";
import {
  PlatformError as PlatformErrorClass,
  WriteObservation as WriteObservationSchema,
} from "@paneform/layout";
import type { PermissionStatus, SettingsTarget } from "./protocol.ts";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  decodePlatformEvent,
  BatchResult,
  ErrorEnvelope,
  FocusResult,
  mapErrorCode,
  OpenedResult,
  KeybindActionEvent,
  KeybindsConfiguredResult,
  PermissionsResult,
  ReadyMessage,
  ResultEnvelope,
  SubscribeResult,
  TopologyResult,
  WindowResult,
  WindowsResult,
} from "./protocol.ts";
import { defaultSpawn, type SidecarProcess, type SpawnSidecar } from "./sidecar-process.ts";

export {
  OpenedResult,
  PermissionStatus,
  PermissionsResult,
  type SettingsTarget,
} from "./protocol.ts";
export { inheritedStdioSpawn } from "./sidecar-process.ts";

// ---------------------------------------------------------------------------
// Pushable async-iterator queue: bridge between raw protocol callbacks and
// effect Streams.
// ---------------------------------------------------------------------------

interface Pushable<T> {
  push(value: T): void;
  end(): void;
  values(): AsyncIterableIterator<T>;
}

const makePushable = <T>(): Pushable<T> => {
  const buffer: T[] = [];
  const wake: Array<{
    readonly owner: symbol;
    readonly resolve: (result: IteratorResult<T>) => void;
  }> = [];
  let ended = false;
  return {
    push(value) {
      if (ended) return;
      const next = wake.shift();
      if (next === undefined) buffer.push(value);
      else next.resolve({ value, done: false });
    },
    end() {
      ended = true;
      while (wake.length > 0) wake.shift()!.resolve({ value: undefined, done: true });
    },
    values() {
      const owner = Symbol();
      let returned = false;
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          if (returned || ended) return Promise.resolve({ value: undefined, done: true });
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift()!, done: false });
          }
          return new Promise<IteratorResult<T>>((resolve) => wake.push({ owner, resolve }));
        },
        return() {
          returned = true;
          const pending = wake.findIndex((entry) => entry.owner === owner);
          if (pending !== -1) wake.splice(pending, 1)[0]!.resolve({ value: undefined, done: true });
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
};

export interface MacOsSidecarOptions {
  /** Explicit path to the `wm-sidecar` executable. Defaults to a freshly
   *  built binary under `packages/platform-macos/sidecar/.build/`. */
  readonly sidecarPath?: string | undefined;
  /** Injectable spawner (tests pass a fake). */
  readonly spawn?: SpawnSidecar | undefined;
}

export interface MacOsSidecarAdapter extends PlatformAdapter {
  /** Structured record of every invalid inbound message. Never silent. */
  readonly protocolErrors: Stream.Stream<string>;
  readonly keybindActions: Stream.Stream<string>;
  /** Resolves once the handshake has been received from the sidecar. */
  readonly whenReady: Promise<{
    version: string;
    accessibility: boolean;
    screenRecording: boolean;
  }>;
  /** Resolves when the sidecar exits, allowing supervisors to restart the host. */
  readonly whenExited: Promise<number | null>;
  /** Path the sidecar was spawned from (surfaced by CLI diagnostics). */
  readonly sidecarPath: string;
  /** Read-only TCC snapshot; never triggers prompts. */
  readonly permissionsStatus: () => Effect.Effect<PermissionStatus, PlatformError>;
  /**
   * Asks the SIDECAR to trigger TCC prompts (AXIsProcessTrustedWithOptions
   * with prompt + CGRequestScreenCaptureAccess) and returns current statuses.
   * Idempotent for already-granted permissions.
   */
  readonly requestPermissions: () => Effect.Effect<PermissionStatus, PlatformError>;
  readonly configureKeybinds: (
    keybinds: Readonly<Record<string, string>>,
  ) => Effect.Effect<void, PlatformError>;
  /** Deep link into a System Settings privacy pane via the sidecar. */
  readonly openPermissionsSettings: (
    target: SettingsTarget,
  ) => Effect.Effect<void, PlatformError>;
  /** Terminates the sidecar process and completes all streams. */
  stop(): void;
}

interface ReadyInfo {
  version: string;
  accessibility: boolean;
  screenRecording: boolean;
}

const REQUEST_TIMEOUT_MS = 15_000;

const makeError = (code: PlatformError["code"], detail: string): PlatformError =>
  new PlatformErrorClass({
    code,
    ...(detail !== undefined ? { detail } : {}),
  });

const resolveDefaultSidecarPath = (): string => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const variant of ["release", "debug"]) {
    const candidate = `${here}../sidecar/.build/${variant}/wm-sidecar`;
    if (existsSync(candidate)) return candidate;
  }
  // Let spawn fail with a clear ENOENT, surfaced as a defect.
  return "wm-sidecar";
};

interface PendingEntry {
  readonly op: string;
  readonly schema: Schema.Schema<unknown, unknown>;
  readonly timeout: NodeJS.Timeout;
  resume(effect: Effect.Effect<unknown, PlatformError>): void;
}

/**
 * Spawns the Swift sidecar and translates its newline-delimited JSON protocol
 * into the engine's PlatformAdapter, exactly per
 * docs/rewrite/platform-contract.md. Every inbound message is schema-validated
 * before entering the engine; invalid messages become structured protocol
 * errors, never silent drops.
 */
export const createMacOsSidecarAdapter = (
  options: MacOsSidecarOptions = {},
): Effect.Effect<MacOsSidecarAdapter> =>
  Effect.sync(() => {
    const spawn: SpawnSidecar = options.spawn ?? defaultSpawn;
    const path = options.sidecarPath ?? resolveDefaultSidecarPath();

    let child: SidecarProcess;
    try {
      child = spawn(path);
    } catch (cause) {
      // Environment defect: the adapter cannot exist without the process.
      throw new Error(`failed to spawn sidecar at "${path}"`, { cause });
    }

    const events = makePushable<PlatformEvent>();
    const issues = makePushable<string>();
    const keybindActions = makePushable<string>();
    const pending = new Map<string, PendingEntry>();

    let reqCounter = 0;
    let alive = true;

    let resolveReady!: (info: ReadyInfo) => void;
    const whenReady = new Promise<ReadyInfo>((resolve) => {
      resolveReady = resolve;
    });
    // Methods may be invoked before the handshake arrives; they queue until
    // ready, or fail fast if the handshake never comes.
    const readySettled = whenReady.catch(() => undefined);
    let resolveExited!: (code: number | null) => void;
    const whenExited = new Promise<number | null>((resolve) => {
      resolveExited = resolve;
    });

    const issue = (reason: string) => {
      issues.push(reason);
      process.stderr.write(`[platform-macos] protocol error: ${reason}\n`);
    };

    const complete = (reqId: string, effect: Effect.Effect<unknown, PlatformError>) => {
      const entry = pending.get(reqId);
      if (entry === undefined) return false;
      clearTimeout(entry.timeout);
      pending.delete(reqId);
      entry.resume(effect);
      return true;
    };

    const failPendingAll = (detail: string) => {
      for (const reqId of pending.keys()) {
        complete(reqId, Effect.fail(makeError("unavailable", detail)));
      }
    };

    const writeLine = (line: string): boolean => {
      if (!alive) return false;
      try {
        (child.stdin as NodeJS.WritableStream).write(`${line}\n`);
        return true;
      } catch (cause) {
        process.stderr.write(`[platform-macos] stdin write failed: ${String(cause)}\n`);
        return false;
      }
    };

    const request = <A>(
      op: string,
      expected: Schema.Schema<A>,
      params: Record<string, unknown> = {},
    ): Effect.Effect<A, PlatformError> =>
      Effect.async<A, PlatformError>((resume) => {
        void (async () => {
          await readySettled;
          if (!alive) {
            resume(Effect.fail(makeError("unavailable", "sidecar is not running")));
            return;
          }
          const reqId = `r${++reqCounter}`;
          const timeout = setTimeout(() => {
            complete(
              reqId,
              Effect.fail(
                makeError("unavailable", `${op} timed out after ${REQUEST_TIMEOUT_MS}ms`),
              ),
            );
            issue(`${op} (${reqId}) timed out`);
          }, REQUEST_TIMEOUT_MS);
          pending.set(reqId, {
            op,
            schema: expected as Schema.Schema<unknown, unknown>,
            timeout,
            resume: resume as (effect: Effect.Effect<unknown, PlatformError>) => void,
          });
          writeLine(JSON.stringify({ op, reqId, ...params }));
        })();
      });

    // -- inbound line handling -------------------------------------------------

    const onResult = (reqId: string, result: unknown) => {
      const entry = pending.get(reqId);
      if (entry === undefined) {
        issue(`result for untracked reqId "${reqId}"`);
        return;
      }
      const decoded = Schema.decodeUnknownEither(entry.schema)(result);
      if (Either.isLeft(decoded)) {
        issue(`invalid ${entry.op} result for "${reqId}": ${String(decoded.left)}`);
        complete(reqId, Effect.fail(makeError("unavailable", `invalid ${entry.op} result`)));
        return;
      }
      complete(reqId, Effect.succeed(decoded.right));
    };

    const onLine = (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        issue(`unparseable line: ${trimmed.slice(0, 120)}`);
        return;
      }

      // Handshake.
      const ready = Schema.decodeUnknownEither(ReadyMessage)(raw);
      if (Either.isRight(ready)) {
        resolveReady({
          version: ready.right.version,
          accessibility: ready.right.accessibility,
          screenRecording: ready.right.screenRecording,
        });
        // Subscribe immediately; its response is correlated like any other.
        const reqId = `r${++reqCounter}`;
        const timeout = setTimeout(() => {
          pending.delete(reqId);
        }, REQUEST_TIMEOUT_MS);
        pending.set(reqId, {
          op: "subscribe",
          schema: SubscribeResult as Schema.Schema<unknown, unknown>,
          timeout,
          resume: () => {},
        });
        writeLine(JSON.stringify({ op: "subscribe", reqId }));
        return;
      }

      // Events.
      const event = decodePlatformEvent(raw);
      if (Either.isRight(event)) {
        events.push(event.right);
        return;
      }

      const keybind = Schema.decodeUnknownEither(KeybindActionEvent)(raw);
      if (Either.isRight(keybind)) {
        keybindActions.push(keybind.right.action);
        return;
      }

      // Correlated / uncorrelated errors. Checked BEFORE results: an error
      // envelope carries no "result" key, but Schema.Unknown would otherwise
      // accept its absence and misroute the message into onResult.
      const failure = Schema.decodeUnknownEither(ErrorEnvelope)(raw);
      if (Either.isRight(failure)) {
        const { code, detail } = failure.right.error;
        const reqId = failure.right.reqId;
        const mappedCode = mapErrorCode(code) as PlatformError["code"];
        if (
          typeof reqId === "string" &&
          complete(reqId, Effect.fail(makeError(mappedCode, detail ?? code)))
        ) {
          return;
        }
        issue(`uncorrelated sidecar error ${code}: ${detail ?? ""}`);
        return;
      }

      // Correlated results.
      const envelope = Schema.decodeUnknownEither(ResultEnvelope)(raw);
      if (Either.isRight(envelope)) {
        onResult(envelope.right.reqId, envelope.right.result);
        return;
      }

      issue(`message matched no protocol shape: ${trimmed.slice(0, 160)}`);
    };

    const readline = createInterface({ input: child.stdout as NodeJS.ReadableStream });
    readline.on("line", onLine);
    (child.stderr as NodeJS.ReadableStream).on("data", (chunk: Buffer) => {
      process.stderr.write(`[wm-sidecar] ${chunk.toString("utf8")}`);
    });

    const terminateStreams = () => {
      events.end();
      issues.end();
      keybindActions.end();
    };

    child.onExit((code) => {
      alive = false;
      failPendingAll("sidecar exited");
      terminateStreams();
      readline.close();
      resolveExited(code);
    });

    // -- adapter ---------------------------------------------------------------

    const guarded = <A>(
      effect: Effect.Effect<A, PlatformError>,
    ): Effect.Effect<A, PlatformError> =>
      Effect.suspend(() =>
        alive ? effect : Effect.fail(makeError("unavailable", "sidecar is not running")),
      );

    const adapter: MacOsSidecarAdapter = {
      events: Stream.fromAsyncIterable(events.values(), (error) => error as never),
      protocolErrors: Stream.fromAsyncIterable(issues.values(), (error) => error as never),
      keybindActions: Stream.fromAsyncIterable(keybindActions.values(), (error) => error as never),
      getTopology: () =>
        Effect.map(
          guarded(request("getTopology", TopologyResult)),
          ({ topology }) => topology,
        ),
      getWindows: () =>
        Effect.map(
          guarded(request("getWindows", WindowsResult)),
          ({ windows }) => windows,
        ),
      getWindow: (id: WindowId) =>
        Effect.map(guarded(request("getWindow", WindowResult, { id })), ({ window }) => window),
      setWindowFrame: (id: WindowId, frame: Frame, expectedIdentity?: ExpectedWindowIdentity) =>
        guarded(request("setWindowFrame", WriteObservationSchema, {
          id,
          frame,
          mode: "frame",
          ...(expectedIdentity ? { expectedIdentity } : {}),
        })),
      setWindowPosition: (id: WindowId, point: Point, expectedIdentity?: ExpectedWindowIdentity) =>
        guarded(request("setWindowFrame", WriteObservationSchema, {
          id,
          frame: { ...point, width: 0, height: 0 },
          mode: "position",
          ...(expectedIdentity ? { expectedIdentity } : {}),
        })),
      setWindowSize: (id: WindowId, size: Size, expectedIdentity?: ExpectedWindowIdentity) =>
        guarded(request("setWindowFrame", WriteObservationSchema, {
          id,
          frame: { x: 0, y: 0, ...size },
          mode: "size",
          ...(expectedIdentity ? { expectedIdentity } : {}),
        })),
      focusWindow: (id: WindowId, expected?: ExpectedWindowIdentity) =>
        guarded(request("focusWindow", FocusResult, {
          id,
          ...(expected === undefined ? {} : { expectedIdentity: expected }),
        })),
      executeBatch: (batch: PlatformBatchRequest): Effect.Effect<PlatformBatchResult, PlatformError> =>
        guarded(request("executeBatch", BatchResult, { operations: batch.operations })),
      permissionsStatus: () =>
        Effect.map(
          guarded(request("permissionsStatus", PermissionsResult)),
          ({ permissions }) => permissions,
        ),
      requestPermissions: () =>
        Effect.map(
          guarded(request("requestPermissions", PermissionsResult)),
          ({ permissions }) => permissions,
        ),
      configureKeybinds: (keybinds) =>
        Effect.asVoid(guarded(request("configureKeybinds", KeybindsConfiguredResult, { keybinds }))),
      openPermissionsSettings: (target: SettingsTarget) =>
        Effect.asVoid(guarded(request("openPermissionsSettings", OpenedResult, { target }))),
      sidecarPath: path,
      whenReady,
      whenExited,
      stop: () => {
        if (!alive) return;
        alive = false;
        failPendingAll("adapter stopped");
        child.kill();
        terminateStreams();
        readline.close();
      },
    };
    return adapter;
  });
