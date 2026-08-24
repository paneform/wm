import { Effect, Stream } from "effect";
import type { Command, DomainEvent } from "@wm/engine";
import { decodeWireMessage, encodeWireMessage, wireSnapshot } from "@wm/engine";
import type { StateSnapshot, WireMessage } from "@wm/engine";
import type { WebSocketServer } from "ws";

export interface WsSession {
  send(text: string): void;
}

export interface CreateWsServerOptions {
  /** Executes a decoded command; resolves the response payload. */
  handle(command: Command): Promise<unknown>;
  /** Committed snapshot provider for subscribe. */
  snapshot(): Promise<StateSnapshot>;
  /** Engine domain events; fanned out to subscribed sessions. */
  events(): Stream.Stream<DomainEvent>;
}

/**
 * Thin WebSocket adapter: decodes inbound envelopes with engine schemas,
 * routes Requests to the shared command executor, fans out Events/Snapshots.
 */
export function attachWebSocketServer(
  server: WebSocketServer,
  options: CreateWsServerOptions,
): void {
  const subscribers = new Set<WsSession>();

  Effect.runFork(
    Stream.runForEach(options.events(), (event) =>
      Effect.sync(() => {
        const text = encodeWireMessage({
          v: 1,
          type: "event",
          seq: event.seq,
          topic: event.topic,
          payload: event.payload,
        });
        for (const session of subscribers) session.send(text);
      }),
    ),
  );

  server.on("connection", (socket) => {
    const session: WsSession = {
      send: (text) => socket.readyState === socket.OPEN && socket.send(text),
    };
    let subscribed = false;
    socket.on("message", (raw) => {
      void handleRaw(String(raw));
    });

    const reply = (id: string, message: WireMessage): void => session.send(encodeWireMessage(message));

    async function handleRaw(raw: string): Promise<void> {
      let message;
      try {
        message = decodeWireMessage(raw);
      } catch (e) {
        reply("?", {
          v: 1,
          type: "response",
          id: "?",
          ok: false,
          error: { code: "invalid_request", message: `undecodable message: ${String(e)}` },
        });
        return;
      }
      if (message.type !== "request") return;
      if (subscribed) return;
      try {
        if (message.command.type === "subscribe") {
          subscribed = true;
          subscribers.add(session);
          reply(message.id, wireSnapshot(await options.snapshot()));
          reply(message.id, { v: 1, type: "response", id: message.id, ok: true, data: { subscribed: true } });
          return;
        }
        const data = await options.handle(message.command);
        reply(message.id, { v: 1, type: "response", id: message.id, ok: true, data });
      } catch (e) {
        reply(message.id, {
          v: 1,
          type: "response",
          id: message.id,
          ok: false,
          error: { code: "internal_error", message: String(e) },
        });
      }
    }

    socket.on("close", () => subscribers.delete(session));
  });
}
