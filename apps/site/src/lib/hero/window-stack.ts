export function updateWindowStack(
  previous: readonly string[],
  windowIds: readonly string[],
  focusedWindow: string | null,
): string[] {
  const live = new Set(windowIds);
  const known = new Set(previous);
  const stack = [
    ...previous.filter((id) => live.has(id)),
    ...windowIds.filter((id) => !known.has(id)),
  ];
  return focusedWindow !== null && live.has(focusedWindow)
    ? [...stack.filter((id) => id !== focusedWindow), focusedWindow]
    : stack;
}
