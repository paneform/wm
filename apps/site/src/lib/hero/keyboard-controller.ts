import type { HeroCommand, KeyboardChord, KeyboardKey, KeyboardKeyId } from "$lib/design/tokens.js";

export type KeyboardPressSource = "script" | "user";

export interface KeyboardSnapshot {
  pressed: ReadonlySet<KeyboardKeyId>;
  scriptPressed: ReadonlySet<KeyboardKeyId>;
  userPressed: ReadonlySet<KeyboardKeyId>;
  activeChord: KeyboardChord | null;
  completedCommand: { sequence: number; chord: KeyboardChord } | null;
}

export interface KeyboardScheduler {
  wait(duration: number, signal?: AbortSignal): Promise<void>;
}

export interface KeyboardControllerOptions {
  layout: readonly KeyboardKey[];
  chords: readonly KeyboardChord[];
  scheduler: KeyboardScheduler;
  dispatch(command: HeroCommand, source: KeyboardPressSource): void | Promise<void>;
  onGlobalRelease?(): void;
  onUserPress?(key: KeyboardKeyId): void;
  onError?(error: Error): void;
  scopeToStage?: boolean;
}

export interface PressOptions {
  key: KeyboardKeyId;
  hold?: boolean;
  source?: KeyboardPressSource;
}

export interface TimedPressOptions extends PressOptions {
  duration: number;
  signal?: AbortSignal;
}

export interface ChordOptions {
  keys: readonly KeyboardKeyId[];
  preHold: number;
  hold: number;
  pressStagger?: number;
  releaseStagger?: number;
  onTrigger?(): void | Promise<void>;
  source?: KeyboardPressSource;
  signal?: AbortSignal;
}

export interface KeyboardStage extends EventTarget {
  ownerDocument?: { defaultView?: EventTarget | null } | null;
}

const modifierCodes = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "Fn",
]);

function isControlTarget(target: EventTarget | null): boolean {
  if (!target) return false;
  // SAFETY: Event targets may be Elements; optional DOM properties are checked before use.
  const candidate = target as {
    closest?: (selector: string) => Element | null;
    isContentEditable?: boolean;
  };
  return Boolean(
    candidate.isContentEditable ||
    candidate.closest?.("a,button,input,textarea,select,[contenteditable='true']"),
  );
}

export function browserKeyboardScheduler(): KeyboardScheduler {
  return {
    wait(duration, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          return;
        }
        const cleanup = () => signal?.removeEventListener("abort", onAbort);
        const timeout = setTimeout(() => {
          cleanup();
          resolve();
        }, duration);
        const onAbort = () => {
          clearTimeout(timeout);
          cleanup();
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

export function createKeyboardController(options: KeyboardControllerOptions) {
  const safariModifierKeyup =
    typeof navigator !== "undefined" &&
    /Safari/.test(navigator.userAgent) &&
    !/(Chrome|Chromium|CriOS|Edg|OPR)/.test(navigator.userAgent);
  const owned = {
    script: new Set<KeyboardKeyId>(),
    user: new Set<KeyboardKeyId>(),
  };
  const listeners = new Set<(snapshot: KeyboardSnapshot) => void>();
  const codeToKey = new Map(
    options.layout.filter((key) => key.code).map((key) => [key.code, key.id]),
  );
  const availableKeys = new Set(options.layout.map(({ id }) => id));
  const modifierIds = new Set(
    options.layout.filter((key) => key.code && modifierCodes.has(key.code)).map((key) => key.id),
  );
  const dispatchedTriggers = new Set<KeyboardKeyId>();
  let activeChord: KeyboardChord | null = null;
  let completedCommand: KeyboardSnapshot["completedCommand"] = null;
  let commandSequence = 0;
  let detachCurrent: (() => void) | null = null;

  const eventKey = (event: KeyboardEvent): KeyboardKeyId | undefined => {
    const side = event.location === 1 ? "left" : event.location === 2 ? "right" : null;
    if (side) {
      const modifier = {
        Shift: side === "left" ? "lshift" : "rshift",
        Control: `control-${side}`,
        Alt: `option-${side}`,
        Meta: `command-${side}`,
      }[event.key];
      if (modifier && availableKeys.has(modifier)) return modifier;
    }
    return codeToKey.get(event.code);
  };

  const modifierPair = (key: KeyboardKeyId): readonly KeyboardKeyId[] | null => {
    const opposite = {
      lshift: "rshift",
      rshift: "lshift",
      "control-left": "control-right",
      "control-right": "control-left",
      "option-left": "option-right",
      "option-right": "option-left",
      "command-left": "command-right",
      "command-right": "command-left",
    }[key];
    return opposite ? [key, opposite] : null;
  };

  const snapshot = (): KeyboardSnapshot => ({
    pressed: new Set([...owned.script, ...owned.user]),
    scriptPressed: new Set(owned.script),
    userPressed: new Set(owned.user),
    activeChord,
    completedCommand,
  });
  const publish = () => {
    const state = snapshot();
    listeners.forEach((listener) => listener(state));
  };
  const matchingChord = (trigger: KeyboardKeyId, source: KeyboardPressSource) => {
    const pressed = owned[source];
    return (
      options.chords.find((chord) => {
        if (chord.trigger !== trigger || !chord.keys.every((key) => pressed.has(key))) return false;
        const requiredModifiers = new Set(chord.keys.filter((key) => modifierIds.has(key)));
        return [...pressed]
          .filter((key) => modifierIds.has(key))
          .every((key) => requiredModifiers.has(key));
      }) ?? null
    );
  };
  const dispatchMatch = (trigger: KeyboardKeyId, source: KeyboardPressSource) => {
    if (dispatchedTriggers.has(trigger)) return null;
    const chord = matchingChord(trigger, source);
    if (!chord) return null;
    dispatchedTriggers.add(trigger);
    activeChord = chord;
    publish();
    Promise.resolve(options.dispatch(chord.command, source)).then(
      () => {
        completedCommand = { sequence: ++commandSequence, chord };
        publish();
      },
      (reason) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        options.onError?.(error);
      },
    );
    return chord;
  };
  const pressOwned = (key: KeyboardKeyId, source: KeyboardPressSource) => {
    if (owned[source].has(key)) return false;
    owned[source].add(key);
    publish();
    return true;
  };
  const releaseOwned = (key: KeyboardKeyId, source: KeyboardPressSource) => {
    if (!owned[source].delete(key)) return false;
    dispatchedTriggers.delete(key);
    if (activeChord?.keys.includes(key)) activeChord = null;
    publish();
    return true;
  };

  const controller = {
    get state() {
      return snapshot();
    },
    subscribe(listener: (snapshot: KeyboardSnapshot) => void) {
      listeners.add(listener);
      listener(snapshot());
      return () => listeners.delete(listener);
    },
    press({ key, source = "script" }: PressOptions) {
      if (pressOwned(key, source)) dispatchMatch(key, source);
    },
    release({ key, source = "script" }: PressOptions) {
      releaseOwned(key, source);
    },
    releaseAll(filter?: { source?: KeyboardPressSource }) {
      const sources: KeyboardPressSource[] = filter?.source ? [filter.source] : ["script", "user"];
      let changed = false;
      for (const source of sources) {
        changed = owned[source].size > 0 || changed;
        owned[source].clear();
      }
      if (changed) {
        dispatchedTriggers.clear();
        activeChord = null;
        publish();
      }
    },
    async tap({ key, duration, source = "script", signal }: TimedPressOptions) {
      const acquired = pressOwned(key, source);
      try {
        if (acquired) dispatchMatch(key, source);
        await options.scheduler.wait(duration, signal);
      } finally {
        if (acquired) releaseOwned(key, source);
      }
    },
    async chord({
      keys,
      preHold,
      hold,
      pressStagger = 0,
      releaseStagger = 0,
      onTrigger,
      source = "script",
      signal,
    }: ChordOptions) {
      const acquired: KeyboardKeyId[] = [];
      try {
        const modifiers = keys.slice(0, -1);
        for (const [index, key] of modifiers.entries()) {
          if (pressOwned(key, source)) acquired.push(key);
          if (pressStagger && index < modifiers.length - 1) {
            await options.scheduler.wait(pressStagger, signal);
          }
        }
        await options.scheduler.wait(preHold, signal);
        const trigger = keys.at(-1);
        if (!trigger) return;
        if (pressOwned(trigger, source)) acquired.push(trigger);
        dispatchMatch(trigger, source);
        await onTrigger?.();
        await options.scheduler.wait(hold, signal);
      } finally {
        for (const key of acquired.reverse()) {
          releaseOwned(key, source);
          if (releaseStagger) await options.scheduler.wait(releaseStagger);
        }
      }
    },
    attach(stage: KeyboardStage) {
      if (detachCurrent) return detachCurrent;
      const root = stage.ownerDocument?.defaultView ?? null;
      const onKeyDown = (rawEvent: Event) => {
        // SAFETY: This callback is registered only for keyboard event names.
        const event = rawEvent as KeyboardEvent;
        if (event.defaultPrevented || event.isComposing || isControlTarget(event.target)) return;
        const key = eventKey(event);
        if (!key) return;
        if (key === "escape") {
          controller.releaseAll();
          return;
        }
        if (event.repeat || owned.user.has(key)) return;
        options.onUserPress?.(key);
        pressOwned(key, "user");
        const chord = dispatchMatch(key, "user");
        if (chord) event.preventDefault();
      };
      const onKeyUp = (rawEvent: Event) => {
        // SAFETY: This callback is registered only for keyboard event names.
        const event = rawEvent as KeyboardEvent;
        const key = eventKey(event);
        if (!key) return;
        const pair = modifierPair(key);
        if (safariModifierKeyup && pair && !event.getModifierState(event.key)) {
          for (const modifier of pair) releaseOwned(modifier, "user");
          return;
        }
        releaseOwned(key, "user");
      };
      const onGlobalRelease = () => {
        options.onGlobalRelease?.();
        controller.releaseAll();
      };
      const keydownTarget = options.scopeToStage ? stage : (root ?? stage);
      const keyupTarget = root ?? stage;
      keydownTarget.addEventListener("keydown", onKeyDown);
      keyupTarget.addEventListener("keyup", onKeyUp);
      root?.addEventListener("blur", onGlobalRelease);
      root?.addEventListener("pagehide", onGlobalRelease);
      let detached = false;
      detachCurrent = () => {
        if (detached) return;
        detached = true;
        keydownTarget.removeEventListener("keydown", onKeyDown);
        keyupTarget.removeEventListener("keyup", onKeyUp);
        root?.removeEventListener("blur", onGlobalRelease);
        root?.removeEventListener("pagehide", onGlobalRelease);
        controller.releaseAll();
        detachCurrent = null;
      };
      return detachCurrent;
    },
    stop() {
      detachCurrent?.();
      controller.releaseAll();
    },
  };

  return controller;
}

export type KeyboardController = ReturnType<typeof createKeyboardController>;
