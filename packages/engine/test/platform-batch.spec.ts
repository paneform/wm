import { describe, expect, test } from "vitest";
import { Effect } from "effect";
import type { Clock } from "../src/platform.ts";
import { windowIdentityFingerprint } from "../src/schema.ts";
import { createFakePlatform, makeWindow } from "./helpers/fake-platform.ts";

const clock: Clock = { now: () => 0, sleep: () => Effect.void };

describe("PlatformAdapter native batches", () => {
  test("independent windows overlap deterministically and results retain request order", async () => {
    const fake = createFakePlatform({ clock });
    const first = fake.addWindow(makeWindow());
    const second = fake.addWindow(makeWindow());
    const observations = await Effect.runPromise(fake.adapter.getWindows());
    const expected = (id: string) => ({
      fingerprint: windowIdentityFingerprint(observations.find((window) => window.id === id)!),
    });
    const result = await Effect.runPromise(
      fake.adapter.executeBatch!({
        operations: [
          {
            operationId: "second",
            kind: "setFrame",
            windowId: second,
            frame: { x: 20, y: 20, width: 500, height: 400 },
            expectedIdentity: expected(second),
          },
          {
            operationId: "first",
            kind: "setFrame",
            windowId: first,
            frame: { x: 10, y: 10, width: 500, height: 400 },
            expectedIdentity: expected(first),
          },
        ],
      }),
    );

    expect(result.operations.map((operation) => operation.operationId)).toEqual([
      "second",
      "first",
    ]);
    expect(Math.max(...fake.batchTrace().map((event) => event.active))).toBe(2);
  });

  test("same-window focus follows reveal and stale identities fail without mutation", async () => {
    const fake = createFakePlatform({ clock });
    const id = fake.addWindow(makeWindow({ x: 100, y: 100 }));
    const before = fake.frameOf(id)!;
    const observation = await Effect.runPromise(fake.adapter.getWindow(id));
    const expected = { fingerprint: windowIdentityFingerprint(observation!) };
    fake.swapBackingElement(id);
    const result = await Effect.runPromise(
      fake.adapter.executeBatch!({
        operations: [
          {
            operationId: "reveal",
            kind: "setFrame",
            windowId: id,
            frame: { x: 0, y: 0, width: 600, height: 500 },
            expectedIdentity: expected,
          },
          {
            operationId: "focus",
            kind: "focus",
            windowId: id,
            expectedIdentity: expected,
            dependsOn: ["reveal"],
          },
        ],
      }),
    );

    expect(result.operations.map((operation) => operation.operationId)).toEqual([
      "reveal",
      "focus",
    ]);
    expect(result.operations[0]?.error?.code).toBe("stale");
    expect(result.operations[1]?.error).toBeDefined();
    expect(fake.frameOf(id)).toEqual(before);
    const starts = fake.batchTrace().filter((event) => event.phase === "start");
    expect(starts.map((event) => event.operationId)).toEqual(["reveal", "focus"]);
  });
});
