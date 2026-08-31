import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";

/**
 * Minimal structural surface of a spawned sidecar process. Compatible with
 * node's ChildProcess; injectable for tests.
 */
export interface SidecarProcess {
  readonly pid: number | undefined;
  readonly stdin: WritableStream | NodeJS.WritableStream;
  readonly stdout: ReadableStream | NodeJS.ReadableStream;
  readonly stderr: ReadableStream | NodeJS.ReadableStream;
  kill(signal?: string): void;
  onExit(listener: (code: number | null) => void): void;
}

export type SpawnSidecar = (path: string) => SidecarProcess;

export const defaultSpawn: SpawnSidecar = (path) => {
  const child: ChildProcess = nodeSpawn(path, ["sidecar"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  return {
    get pid() {
      return child.pid;
    },
    stdin: child.stdin!,
    stdout: child.stdout!,
    stderr: child.stderr!,
    kill(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill(signal as NodeJS.Signals);
      }
    },
    onExit(listener) {
      child.once("exit", (code) => listener(code));
    },
  };
};

/** Native-parent mode: stdout carries requests to Swift and stdin carries
 * responses/events back from Swift. Human logs must use stderr. */
export const inheritedStdioSpawn = (
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): SpawnSidecar => () => {
  const listeners: Array<(code: number | null) => void> = [];
  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    for (const listener of listeners) listener(null);
  };
  input.once("end", finish);
  input.once("close", finish);
  return {
    pid: process.ppid,
    stdin: output,
    stdout: input,
    stderr: Readable.from([]),
    kill() {},
    onExit(listener) {
      listeners.push(listener);
      if (ended) listener(null);
    },
  };
};
