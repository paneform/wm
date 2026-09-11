export type ArbiterResult<Value> =
  | { readonly status: "completed"; readonly value: Value }
  | { readonly status: "superseded" }
  | { readonly status: "invalidated" };

interface Pending<Value> {
  readonly run: () => Promise<Value>;
  readonly resolve: (result: ArbiterResult<Value>) => void;
  readonly reject: (reason: Error) => void;
}

export interface ActionArbiter {
  generation(): number;
  beginAutoplay(): number;
  invalidateAutoplay(): void;
  submitScript<Value>(generation: number, run: () => Promise<Value>): Promise<ArbiterResult<Value>>;
  submitUser<Value>(run: () => Promise<Value>): Promise<ArbiterResult<Value>>;
  dispose(): Promise<void>;
}

export function createActionArbiter(): ActionArbiter {
  let generation = 0;
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let pending: Pending<unknown> | null = null;

  const drain = <Value>(entry: Pending<Value>): void => {
    const task = (async () => {
      let result: ArbiterResult<Value> | undefined;
      let failure: Error | undefined;
      try {
        result = { status: "completed", value: await entry.run() };
      } catch (cause) {
        failure = cause instanceof Error ? cause : new Error(String(cause));
      } finally {
        inFlight = null;
        const next = pending;
        pending = null;
        if (next !== null && !disposed) drain(next);
        else if (next !== null) next.resolve({ status: "invalidated" });
      }
      if (result !== undefined) entry.resolve(result);
      else entry.reject(failure ?? new Error("Action failed"));
    })();
    inFlight = task;
  };

  const submit = <Value>(entry: Pending<Value>, user: boolean): void => {
    if (disposed) {
      entry.resolve({ status: "invalidated" });
      return;
    }
    if (inFlight === null) {
      drain(entry);
      return;
    }
    if (!user) {
      entry.resolve({ status: "superseded" });
      return;
    }
    pending?.resolve({ status: "superseded" });
    // SAFETY: This wrapper preserves the entry's run/resolve pair while queue storage erases Value.
    pending = {
      run: entry.run,
      resolve: (result) => entry.resolve(result as ArbiterResult<Value>),
      reject: entry.reject,
    };
  };

  return {
    generation: () => generation,
    beginAutoplay: () => {
      generation += 1;
      return generation;
    },
    invalidateAutoplay: () => {
      generation += 1;
    },
    submitScript: (candidate, run) =>
      new Promise((resolve, reject) => {
        if (candidate !== generation) {
          resolve({ status: "invalidated" });
          return;
        }
        submit({ run, resolve, reject }, false);
      }),
    submitUser: (run) =>
      new Promise((resolve, reject) => {
        generation += 1;
        submit({ run, resolve, reject }, true);
      }),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      generation += 1;
      pending?.resolve({ status: "invalidated" });
      pending = null;
      await inFlight;
    },
  };
}
