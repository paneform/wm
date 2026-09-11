import { parseConfig, type Config } from "@paneform/layout";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { MAX_SCENARIO_BYTES } from "./scenario-url.js";

export const RECOMMENDED_CONFIG_PATH = "~/.config/paneform/wm/config.jsonc";
export const LOCAL_CONFIG_PICKER_ID = "paneform-wm-local-config";

export function parseLocalConfig(text: string): Config {
  if (new TextEncoder().encode(text).byteLength > MAX_SCENARIO_BYTES) {
    throw new Error("Config JSONC exceeds the 1 MiB size limit.");
  }
  const errors: ParseError[] = [];
  const raw: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
  const first = errors[0];
  if (first) {
    throw new Error(
      `Invalid JSONC: ${printParseErrorCode(first.error)} at offset ${first.offset}.`,
    );
  }
  return parseConfig(raw);
}

export async function loadLocalConfigFile(file: File): Promise<Config> {
  if (file.size > MAX_SCENARIO_BYTES) throw new Error("Config JSONC exceeds the 1 MiB size limit.");
  return parseLocalConfig(await file.text());
}
