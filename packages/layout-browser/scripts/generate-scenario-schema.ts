import { writeFile } from "node:fs/promises";
import { scenarioJsonSchema } from "../src/scenario.js";

await writeFile(
  new URL("../scenario.schema.json", import.meta.url),
  `${JSON.stringify(scenarioJsonSchema, null, 2)}\n`,
);
