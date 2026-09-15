export function reorderItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to)
    return [...items];
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export type ReorderGesture<T> = {
  readonly items: readonly T[];
  readonly index: number;
  readonly unsaved: boolean;
  readonly page: number;
  readonly error: string;
};

export function beginReorderGesture<T>(
  items: readonly T[],
  index: number,
  unsaved: boolean,
  page: number,
  error: string,
): ReorderGesture<T> {
  return { items: [...items], index, unsaved, page, error };
}
