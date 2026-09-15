import { env } from "$env/dynamic/private";
import { isPlaygroundPath, requirePlayground } from "$lib/server/playground.js";
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  // Data requests can skip layout loads, so enforce the boundary before routing.
  const playground = isPlaygroundPath(event.route.id ?? event.url.pathname);
  if (!playground) return resolve(event);
  requirePlayground(env);
  const resolved = await resolve(event);
  const response = new Response(resolved.body, resolved);
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("x-robots-tag", "noindex, nofollow");
  return response;
};
