import { describe, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { executeClientCommand } from "../src/command-client.ts";

describe("CLI command output over WebSocket", () => {
  test("compact and verbose outputs use the same single request", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No server port");
    const requests: unknown[] = [];
    server.on("connection", (socket) =>
      socket.on("message", (raw) => {
        const request = JSON.parse(String(raw));
        requests.push(request.command);
        socket.send(
          JSON.stringify({
            v: 1,
            type: "response",
            id: request.id,
            ok: true,
            data: { type: "windows", currentWorkspace: "2", windows: [] },
          }),
        );
      }),
    );
    try {
      const url = `ws://127.0.0.1:${address.port}`;
      expect(await executeClientCommand(url, { type: "getWindows" })).toEqual({
        ok: true,
        output: { currentWorkspace: "2", windows: [] },
      });
      const verbose = await executeClientCommand(url, { type: "getWindows" }, true);
      expect(verbose).toMatchObject({
        ok: true,
        output: {
          v: 1,
          type: "response",
          id: expect.any(String),
          ok: true,
          data: { type: "windows", currentWorkspace: "2", windows: [] },
        },
      });
      expect(requests).toEqual([{ type: "getWindows" }, { type: "getWindows" }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
