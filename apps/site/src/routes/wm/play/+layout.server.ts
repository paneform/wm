import { requirePlayground } from "$lib/server/playground.js";
import { env } from "$env/dynamic/private";
import type { LayoutServerLoad } from "./$types";

// Never emit static playground pages that could bypass the request-time gate.
export const prerender = false;

export const load: LayoutServerLoad = () => {
  requirePlayground(env);
};
