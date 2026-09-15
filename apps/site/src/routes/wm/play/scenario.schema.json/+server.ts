import { scenarioJsonSchema } from "@paneform/layout-browser";
import { json } from "@sveltejs/kit";
import { requirePlayground } from "$lib/server/playground.js";
import { env } from "$env/dynamic/private";

export const prerender = false;

export function GET() {
  requirePlayground(env);
  return json(scenarioJsonSchema);
}
