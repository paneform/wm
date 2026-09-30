export interface RailPoint {
  x: number;
  y: number;
}

export function bend(previous: RailPoint, next: RailPoint) {
  const middle = (previous.y + next.y) / 2;
  const radius = Math.min(6, (next.y - previous.y) / 4);
  return { from: middle - radius, to: middle + radius };
}

export function railPath(points: readonly RailPoint[], height: number): string {
  if (!points.length) return "";
  const commands = [`M ${points[0]!.x} 0`];
  points.forEach((point, index) => {
    const previous = points[index - 1];
    if (previous && previous.x !== point.x) {
      const { from, to } = bend(previous, point);
      commands.push(`L ${previous.x} ${from}`, `L ${point.x} ${to}`);
    }
    commands.push(`L ${point.x} ${point.y}`);
  });
  commands.push(`L ${points.at(-1)!.x} ${height}`);
  return commands.join(" ");
}

export function straightRange(
  points: readonly RailPoint[],
  index: number,
  top: number,
  bottom: number,
) {
  const point = points[index]!;
  const previous = points[index - 1];
  const next = points[index + 1];
  const start =
    previous && previous.x !== point.x ? Math.max(top, bend(previous, point).to + 2) : top;
  const end = next && next.x !== point.x ? Math.min(bottom, bend(point, next).from - 2) : bottom;
  return start < end ? { start, end } : { start: point.y - 1, end: point.y + 1 };
}
