// oxlint-disable -- Worker messages are an external protocol validated by isRequest before use.

import {
  createScenarioSession,
  type ScenarioSession,
  type ScenarioStep,
} from "@paneform/layout-browser";

type Request =
  | { id: number; type: "create"; input: unknown }
  | { id: number; type: "apply"; step: ScenarioStep }
  | { id: number; type: "snapshot" | "step" | "run" | "dispose" };

let session: ScenarioSession | null = null;

function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : "Scenario worker failed.").slice(0, 2_000);
}

function isRequest(value: unknown): value is Request {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Record<string, unknown>;
  return (
    Number.isSafeInteger(request.id) &&
    (request.type === "create" ||
      request.type === "snapshot" ||
      request.type === "apply" ||
      request.type === "step" ||
      request.type === "run" ||
      request.type === "dispose")
  );
}

self.onmessage = async (event: MessageEvent<unknown>) => {
  if (!isRequest(event.data)) return;
  const { id, type } = event.data;
  try {
    if (type === "create") {
      await session?.dispose();
      session = await createScenarioSession(event.data.input);
      self.postMessage({ id, result: null });
      return;
    }
    if (!session) throw new Error("Scenario session is not ready.");
    if (type === "dispose") {
      await session.dispose();
      session = null;
      self.postMessage({ id, result: null });
      return;
    }
    self.postMessage({
      id,
      result: type === "apply" ? await session.apply(event.data.step) : await session[type](),
    });
  } catch (cause) {
    self.postMessage({ id, error: errorMessage(cause) });
  }
};
