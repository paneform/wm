import type {
  CommandDemoManifest,
  DemoCommandId,
  ScenarioDescriptor,
} from "../src/lib/docs/demo-manifest.js";

// These deliberately invalid declarations must fail compilation. If a contract
// widens to string/optional keys, TypeScript reports the unused expect-error.

// @ts-expect-error All engine commands and service actions require a coverage decision.
export const missingCoverage: CommandDemoManifest = {};

// @ts-expect-error A misspelled command identity is not a manifest key.
export const misspelledCommand: DemoCommandId = "moveDiretion";

// @ts-expect-error File IDs are literal keys of the imported scenario inventory.
export const missingFile: ScenarioDescriptor["file"] = "nonexistent.json";

// @ts-expect-error A desktop entry requires at least one situation.
export const emptyDemo: CommandDemoManifest["moveDirection"] = { kind: "desktop", situations: [] };

// @ts-expect-error Unsupported commands must explain why a scenario is unavailable.
export const silentException: CommandDemoManifest["subscribe"] = { kind: "unavailable" };
