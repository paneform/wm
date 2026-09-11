// oxlint-disable -- Worker messages are an external protocol validated by isResponse before use.

import type { ScenarioSession, ScenarioStep } from "@paneform/layout-browser";

export type ScenarioClient = Pick<
  ScenarioSession,
  "snapshot" | "apply" | "step" | "run" | "dispose"
>;

export type WorkerLike = Pick<Worker, "onerror" | "onmessage" | "postMessage" | "terminate">;

export type WorkerFactory = () => WorkerLike;

interface Response {
  id: number;
  result?: unknown;
  error?: string;
}

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL("./scenario-worker.ts", import.meta.url), { type: "module" });

function isResponse(value: unknown): value is Response {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(response.id) &&
    (response.error === undefined || typeof response.error === "string")
  );
}

export async function createScenarioClient(
  input: unknown,
  factory: WorkerFactory = defaultWorkerFactory,
  timeoutMilliseconds = 5_000,
  signal?: AbortSignal,
): Promise<ScenarioClient> {
  const worker = factory();
  let nextId = 0;
  let disposed = false;
  const pending = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  function terminate(error: Error) {
    if (disposed) return;
    disposed = true;
    signal?.removeEventListener("abort", abort);
    worker.terminate();
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
  }

  const abort = () => terminate(new Error("Scenario worker was disposed."));
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  function request<T>(
    type: "create" | "apply" | "snapshot" | "step" | "run",
    requestInput?: unknown,
  ): Promise<T> {
    if (disposed) return Promise.reject(new Error("Scenario worker has been disposed."));
    const id = ++nextId;
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        terminate(new Error(`Scenario worker timed out after ${timeoutMilliseconds}ms.`));
      }, timeoutMilliseconds);
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timeout });
      worker.postMessage(
        type === "create"
          ? { id, type, input: requestInput }
          : type === "apply"
            ? { id, type, step: requestInput }
            : { id, type },
      );
    });
  }

  worker.onmessage = (event) => {
    if (!isResponse(event.data)) return;
    const response = pending.get(event.data.id);
    if (!response) return;
    pending.delete(event.data.id);
    clearTimeout(response.timeout);
    if (event.data.error !== undefined)
      response.reject(new Error(event.data.error.slice(0, 2_000)));
    else response.resolve(event.data.result);
  };
  worker.onerror = (event) =>
    terminate(new Error((event.message ?? "Scenario worker failed.").slice(0, 2_000)));

  await request<void>("create", input).catch((cause) => {
    terminate(cause instanceof Error ? cause : new Error("Scenario worker failed."));
    throw cause;
  });

  return {
    snapshot: () => request("snapshot"),
    apply: (step: ScenarioStep) => request("apply", step),
    step: () => request("step"),
    run: () => request("run"),
    dispose: async () => terminate(new Error("Scenario worker was disposed.")),
  };
}
