import { Effect, Schema, Stream } from "effect";
import { EVENT_REPLAY_BUFFER } from "./constants.js";

// Domain event bus — docs/spec.md §Events.
// Monotonic sequence numbers, bounded replay buffer independent of
// subscribers. Subscribers cannot block state processing.

export const DomainTopic = Schema.Literal(
  "health",
  "config",
  "topology",
  "workspace",
  "window",
  "focus",
  "transaction",
  "reconciliation",
  "repair",
  "pause",
  "diagnostic",
);
export type DomainTopic = typeof DomainTopic.Type;

const EventEnvelope = Schema.Struct({
  seq: Schema.Number.pipe(Schema.int(), Schema.greaterThanOrEqualTo(1)),
  topic: DomainTopic,
  payload: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
});

export interface DomainEvent {
  readonly seq: number;
  readonly topic: DomainTopic;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EventBus {
  /** Validate + assign the next seq + buffer + fan out. */
  publish(topic: DomainTopic, payload: Record<string, unknown>): DomainEvent;
  /** Bounded replay of buffered events with seq > afterSeq (oldest first). */
  replay(afterSeq?: number): readonly DomainEvent[];
  latestSeq(): number;
  events(): Stream.Stream<DomainEvent>;
}

export const createEventBus = (replayLimit: number = EVENT_REPLAY_BUFFER): EventBus => {
  let nextSeq = 1;
  let buffer: DomainEvent[] = [];
  const listeners = new Set<(event: DomainEvent) => void>();

  return {
    publish(topic, payload) {
      // Boundary validation before an event leaves the engine.
      const validated = Schema.decodeUnknownSync(EventEnvelope, {
        onExcessProperty: "error",
      })({ seq: nextSeq, topic, payload });
      const event: DomainEvent = validated;
      nextSeq += 1;
      buffer.push(event);
      if (buffer.length > replayLimit) buffer = buffer.slice(buffer.length - replayLimit);
      for (const listener of listeners) listener(event);
      return event;
    },
    replay(afterSeq = 0) {
      return buffer.filter((event) => event.seq > afterSeq);
    },
    latestSeq() {
      return nextSeq - 1;
    },
    events() {
      return Stream.asyncPush<DomainEvent>((emit) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = (event: DomainEvent): void => {
              emit.single(event);
            };
            listeners.add(listener);
            return listener;
          }),
          (listener) =>
            Effect.sync(() => {
              listeners.delete(listener);
            }),
        ),
      );
    },
  };
};
