/** One source for CSS column width and the docs-only authoring budget. */
export const DEMO_CAPTION_COLUMNS = 32;
export const DEMO_CAPTION_MAX_LENGTH = DEMO_CAPTION_COLUMNS * 2;

const columns = (text: string) => Array.from(text).length;

function captionLines(text: string, label: string): string[] {
  const lines = [""];
  for (const word of text.trim().split(/ +/u)) {
    if (columns(word) > DEMO_CAPTION_COLUMNS)
      throw new Error(`${label} contains a word longer than ${DEMO_CAPTION_COLUMNS} columns`);
    const current = lines.at(-1)!;
    const next = current ? `${current} ${word}` : word;
    if (columns(next) <= DEMO_CAPTION_COLUMNS) lines[lines.length - 1] = next;
    else lines.push(word);
  }
  return lines;
}

export function formatDemoCaption(text: string, label = "Demo caption"): string {
  if (!text.trim() || /[\r\n\t]/u.test(text))
    throw new Error(`${label} must be nonempty single-line text`);
  if (columns(text) > DEMO_CAPTION_MAX_LENGTH)
    throw new Error(`${label} exceeds ${DEMO_CAPTION_MAX_LENGTH} characters`);
  const lines = captionLines(text, label);
  if (lines.length > 2)
    throw new Error(`${label} must fit two ${DEMO_CAPTION_COLUMNS}-column lines`);
  return lines.join("\n");
}
