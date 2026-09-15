import { parseScenario, type LayoutScenario } from "@paneform/layout-browser";

export const MAX_SCENARIO_BYTES = 1024 * 1024;
export const MAX_SCENARIO_FRAGMENT_LENGTH = 32 * 1024;
const prefix = "#scenario=gz.";

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.byteLength;
      if (length > maximum) {
        await reader.cancel();
        throw new Error("Scenario exceeds the share-link size limit. Use JSON instead.");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function encodeScenarioFragment(scenario: LayoutScenario): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parseScenario(scenario)));
  if (bytes.byteLength > MAX_SCENARIO_BYTES) throw new Error("Scenario JSON exceeds 1 MiB.");
  const compressed = await collectBounded(
    new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    Math.floor(((MAX_SCENARIO_FRAGMENT_LENGTH - prefix.length) * 3) / 4),
  );
  const binary = Array.from(compressed, (byte) => String.fromCharCode(byte)).join("");
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${prefix}${encoded}`;
}

export async function decodeScenarioFragment(hash: string): Promise<LayoutScenario | null> {
  if (!hash.startsWith("#scenario=")) return null;
  if (hash.length > MAX_SCENARIO_FRAGMENT_LENGTH)
    throw new Error("Scenario share link is too large.");
  if (!hash.startsWith(prefix)) throw new Error("Unsupported scenario share-link encoding.");
  const encoded = hash.slice(prefix.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new Error("Invalid scenario share-link data.");
  }
  const binary = atob(encoded.replaceAll("-", "+").replaceAll("_", "/"));
  const compressed = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  try {
    const bytes = await collectBounded(
      new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip")),
      MAX_SCENARIO_BYTES,
    );
    return parseScenario(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch (cause) {
    throw new Error(
      "Could not decode this scenario link. It may be invalid or exceed the size limit.",
      { cause },
    );
  }
}
