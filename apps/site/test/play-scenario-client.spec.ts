// oxlint-disable -- Fake Worker messages model an external protocol boundary.

import { describe, expect, it, vi } from "vitest";
import { createScenarioClient, type WorkerLike } from "../src/lib/play/scenario-client.js";

class FakeWorker implements WorkerLike {
  onerror: WorkerLike["onerror"] = null;
  onmessage: WorkerLike["onmessage"] = null;
  readonly requests: unknown[] = [];
  terminated = false;

  postMessage(message: unknown): void {
    this.requests.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  respond(index: number, result: unknown): void {
    const request = this.requests[index] as { id: number };
    this.onmessage?.call(
      this as unknown as Worker,
      { data: { id: request.id, result } } as MessageEvent<unknown>,
    );
  }
}

describe("scenario worker client", () => {
  it("creates a narrow session and routes named requests", async () => {
    const worker = new FakeWorker();
    const creating = createScenarioClient({ state: {} }, () => worker);
    worker.respond(0, null);
    const client = await creating;
    expect(Object.keys(client).sort()).toEqual(["apply", "dispose", "run", "snapshot", "step"]);

    const snapshot = client.snapshot();
    worker.respond(1, { topology: [], windows: [] });
    await expect(snapshot).resolves.toEqual({ topology: [], windows: [] });

    const applied = client.apply({ command: "retile" });
    expect(worker.requests[2]).toMatchObject({ type: "apply", step: { command: "retile" } });
    worker.respond(2, { topology: [], windows: [], wmRunning: true });
    await expect(applied).resolves.toMatchObject({ wmRunning: true });
  });

  it("terminates immediately on dispose and rejects pending work", async () => {
    const worker = new FakeWorker();
    const creating = createScenarioClient({}, () => worker);
    worker.respond(0, null);
    const client = await creating;
    const pending = client.step();
    await client.dispose();
    expect(worker.terminated).toBe(true);
    await expect(pending).rejects.toThrow("disposed");
    await expect(client.snapshot()).rejects.toThrow("disposed");
  });

  it("terminates a worker that exceeds the request deadline", async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const creating = createScenarioClient({}, () => worker, 25);
      const rejected = expect(creating).rejects.toThrow("timed out after 25ms");
      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("can terminate initialization before a client has been returned", async () => {
    const worker = new FakeWorker();
    const abort = new AbortController();
    const creating = createScenarioClient({}, () => worker, 5_000, abort.signal);
    abort.abort();
    await expect(creating).rejects.toThrow("disposed");
    expect(worker.terminated).toBe(true);
  });
});
