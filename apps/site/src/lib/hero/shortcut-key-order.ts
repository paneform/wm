import type { KeyboardChord, KeyboardKey, KeyboardKeyId } from "$lib/design/tokens.js";

const leadingKeyIds = [
  "lshift",
  "control-left",
  "option-left",
  "command-left",
  "command-right",
  "option-right",
  "rshift",
  "space",
] as const;
const alphanumericIds = "0123456789abcdefghijklmnopqrstuvwxyz";

export function sortShortcutKeys(
  keys: readonly KeyboardKey[],
  layout: readonly KeyboardKey[],
): KeyboardKey[] {
  const layoutOrder = new Map(layout.map(({ id }, index) => [id, index]));
  const rank = (key: KeyboardKey): number => {
    const leading = leadingKeyIds.findIndex((id) => id === key.id);
    if (leading >= 0) return leading;
    const alphanumeric = alphanumericIds.indexOf(key.id);
    if (alphanumeric >= 0) return leadingKeyIds.length + alphanumeric;
    return (
      leadingKeyIds.length + alphanumericIds.length + (layoutOrder.get(key.id) ?? layout.length)
    );
  };
  return [...keys].sort((left, right) => rank(left) - rank(right));
}

export function shortcutReadoutKeyIds(
  pressed: ReadonlySet<KeyboardKeyId>,
  activeChord: KeyboardChord | null,
  completedChord: KeyboardChord | null,
): readonly KeyboardKeyId[] {
  return (activeChord ?? completedChord)?.keys ?? [...pressed];
}
