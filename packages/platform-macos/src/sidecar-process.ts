import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";

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
  const child: ChildProcess = nodeSpawn(path, [], {
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
