import WebSocket from "ws";
import { decodeWireMessage, type Command, type WireResponse } from "@paneform/layout";
import { commandOutput } from "./command-output.ts";

function awaitResponse(socket: WebSocket, command: Command): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const finish = (action: () => void) => {
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(
      () =>
        finish(() => {
          socket.terminate();
          reject(new Error("daemon connection timed out"));
        }),
      5_000,
    );
    socket.once("open", () =>
      socket.send(JSON.stringify({ v: 1, type: "request", id: crypto.randomUUID(), command })),
    );
    socket.once("message", (raw) =>
      finish(() => {
        try {
          const response = decodeWireMessage(String(raw));
          if (response.type !== "response")
            throw new Error("Expected a command response from the daemon");
          resolve(response);
        } catch (cause) {
          reject(cause);
        }
      }),
    );
    socket.once("error", (cause) => finish(() => reject(cause)));
    socket.once("close", () =>
      finish(() => reject(new Error("daemon connection closed before a response"))),
    );
  });
}

export async function executeClientCommand(url: string, command: Command, verbose = false) {
  const socket = new WebSocket(url);
  try {
    const response = await awaitResponse(socket, command);
    return { ok: response.ok, output: commandOutput(response, verbose) };
  } finally {
    socket.close();
  }
}
