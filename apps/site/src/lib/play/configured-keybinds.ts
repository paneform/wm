import type { Keybinds } from "@paneform/layout";
import { parseScenarioCommand } from "@paneform/layout-browser";

const modifiers = new Map([
  ["shift", "shift"],
  ["control", "control"],
  ["ctrl", "control"],
  ["option", "alt"],
  ["alt", "alt"],
  ["command", "meta"],
  ["cmd", "meta"],
]);
const modifierGroups = [
  { name: "shift", key: "Shift", flag: "shiftKey", left: "ShiftLeft", right: "ShiftRight" },
  { name: "control", key: "Control", flag: "ctrlKey", left: "ControlLeft", right: "ControlRight" },
  { name: "alt", key: "Alt", flag: "altKey", left: "AltLeft", right: "AltRight" },
  { name: "meta", key: "Meta", flag: "metaKey", left: "MetaLeft", right: "MetaRight" },
] as const;
const keyCodes = new Map([
  ["return", "Enter"],
  ["delete", "Backspace"],
  ["forwarddelete", "Delete"],
  ["escape", "Escape"],
  ["space", "Space"],
  ["tab", "Tab"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["left", "ArrowLeft"],
  ["right", "ArrowRight"],
  ["up", "ArrowUp"],
  ["down", "ArrowDown"],
  ["=", "Equal"],
  ["-", "Minus"],
  ["]", "BracketRight"],
  ["[", "BracketLeft"],
  ["'", "Quote"],
  [";", "Semicolon"],
  ["\\", "Backslash"],
  [",", "Comma"],
  ["/", "Slash"],
  [".", "Period"],
  ["`", "Backquote"],
]);

export interface KeybindIssue {
  chord: string;
  action: string;
  reason: string;
}

interface BrowserChord {
  code: string;
  modifiers: ReadonlySet<string>;
}

/** Modifier events carry side information that a later trigger's flags do not. */
export function createModifierTracker() {
  const pressed = new Set<string>();
  const update = (event: KeyboardEvent, down: boolean) => {
    for (const group of modifierGroups) {
      if (!event[group.flag]) {
        pressed.delete(group.left);
        pressed.delete(group.right);
      }
      const code =
        event.code === group.left || event.code === group.right
          ? event.code
          : (event.key === group.key || (group.key === "Meta" && event.key === "OS")) &&
              (event.location === 1 || event.location === 2)
            ? event.location === 1
              ? group.left
              : group.right
            : null;
      if (code !== null) {
        if (down) pressed.add(code);
        else pressed.delete(code);
      }
    }
    if (event.code === "Fn" || event.key === "Fn") {
      if (down) pressed.add("Fn");
      else pressed.delete("Fn");
    }
  };
  return {
    get pressed(): ReadonlySet<string> {
      return pressed;
    },
    keydown: (event: KeyboardEvent) => update(event, true),
    keyup: (event: KeyboardEvent) => update(event, false),
    reset: () => pressed.clear(),
  };
}

function browserCode(key: string): string | null {
  if (/^[a-z]$/u.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/u.test(key)) return `Digit${key}`;
  if (/^f(?:[1-9]|1[0-2])$/u.test(key)) return key.toUpperCase();
  return keyCodes.get(key) ?? null;
}

function parseChord(source: string): BrowserChord {
  let trigger = "";
  const required = new Set<string>();
  for (const part of source.toLowerCase().trim().split(/\s+/u)) {
    const generic = modifiers.get(part);
    const side = !generic && (part.startsWith("l") || part.startsWith("r")) ? part[0]! : "";
    const modifier =
      generic ??
      (side ? modifiers.get(part.slice(1)) : undefined) ??
      (part === "fn" ? "fn" : undefined);
    if (modifier) {
      const token = side + modifier;
      if (required.has(token)) throw new Error(`duplicate ${part} modifier`);
      required.add(token);
      continue;
    }
    const code = browserCode(part);
    if (!code || trigger) throw new Error(`unsupported key chord`);
    trigger = code;
  }
  if (!trigger) throw new Error("key chord has no trigger key");
  for (const { name } of modifierGroups) {
    if (required.has(name) && (required.has(`l${name}`) || required.has(`r${name}`))) {
      throw new Error(`cannot combine generic and sided ${name} modifiers`);
    }
  }
  return { code: trigger, modifiers: required };
}

function matchesModifiers(
  event: KeyboardEvent,
  required: ReadonlySet<string>,
  pressed: ReadonlySet<string>,
): boolean {
  for (const group of modifierGroups) {
    if (required.has(group.name)) {
      if (!event[group.flag]) return false;
      continue;
    }
    const left = required.has(`l${group.name}`);
    const right = required.has(`r${group.name}`);
    if (
      event[group.flag] !== (left || right) ||
      pressed.has(group.left) !== left ||
      pressed.has(group.right) !== right
    )
      return false;
  }
  return required.has("fn") === (pressed.has("Fn") || (event.getModifierState?.("Fn") ?? false));
}

export function configuredKeybindIssues(keybinds: Keybinds): readonly KeybindIssue[] {
  const issues: KeybindIssue[] = [];
  for (const [chord, action] of Object.entries(keybinds)) {
    try {
      parseChord(chord);
    } catch (error) {
      issues.push({
        chord,
        action,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      parseScenarioCommand(action);
    } catch {
      issues.push({ chord, action, reason: "action is not a supported scenario command" });
    }
  }
  return issues;
}

export function eventToConfiguredCommand(
  event: KeyboardEvent,
  keybinds: Keybinds | undefined,
  pressedModifiers: ReadonlySet<string> = new Set(),
): string | null {
  if (event.defaultPrevented || event.repeat || event.isComposing) return null;
  const bindings = keybinds ?? defaultScenarioKeybinds;
  for (const [source, action] of Object.entries(bindings)) {
    let chord: BrowserChord;
    try {
      chord = parseChord(source);
    } catch {
      continue;
    }
    if (chord.code !== event.code || !matchesModifiers(event, chord.modifiers, pressedModifiers))
      continue;
    try {
      parseScenarioCommand(action);
      return action;
    } catch {
      return null;
    }
  }
  return null;
}

export const defaultScenarioKeybinds: Keybinds = Object.fromEntries(
  (["left", "down", "up", "right"] as const).flatMap((direction, index) => [
    [`shift ${direction}`, `window focus ${direction}`],
    [`shift ${["h", "j", "k", "l"][index]}`, `window focus ${direction}`],
  ]),
);
