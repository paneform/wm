import { createActionArbiter, type ActionArbiter } from "./action-arbiter.js";
import {
  createHeroSimulation,
  type HeroCommittedSnapshot,
  type HeroSimulation,
} from "./create-hero-simulation.js";

export interface SimulationSession {
  readonly generation: number;
  readonly simulation: HeroSimulation;
  readonly arbiter: ActionArbiter;
}

export interface SimulationClient {
  current(): SimulationSession | null;
  start(): Promise<SimulationSession>;
  replay(): Promise<SimulationSession>;
  subscribe(listener: (snapshot: HeroCommittedSnapshot) => void): () => void;
  publish(snapshot: HeroCommittedSnapshot, generation: number): void;
  dispose(): Promise<void>;
}

export function createSimulationClient(
  factory: () => Promise<HeroSimulation> = createHeroSimulation,
): SimulationClient {
  let session: SimulationSession | null = null;
  let generation = 0;
  let transition: Promise<SimulationSession> | null = null;
  let disposePromise: Promise<void> | null = null;
  let disposed = false;
  const listeners = new Set<(snapshot: HeroCommittedSnapshot) => void>();

  const replace = (): Promise<SimulationSession> => {
    if (transition !== null) return transition;
    transition = (async () => {
      const previous = session;
      session = null;
      if (previous !== null) {
        await previous.arbiter.dispose();
        await previous.simulation.dispose();
      }
      if (disposed) throw new Error("Simulation client is disposed");
      const simulation = await factory();
      if (disposed) {
        await simulation.dispose();
        throw new Error("Simulation client is disposed");
      }
      const next = { generation: ++generation, simulation, arbiter: createActionArbiter() };
      session = next;
      return next;
    })().finally(() => {
      transition = null;
    });
    return transition;
  };

  return {
    current: () => session,
    start: async () => session ?? replace(),
    replay: replace,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish: (snapshot, candidate) => {
      if (session?.generation !== candidate || !snapshot.valid) return;
      for (const listener of listeners) listener(snapshot);
    },
    dispose: () =>
      (disposePromise ??= (async () => {
        disposed = true;
        await transition?.catch(() => undefined);
        const current = session;
        session = null;
        if (current !== null) {
          await current.arbiter.dispose();
          await current.simulation.dispose();
        }
        listeners.clear();
      })()),
  };
}
