import { dev } from "$app/environment";
import { error } from "@sveltejs/kit";

export const prerender = false;
export const trailingSlash = "ignore";

export function load() {
  if (!dev) error(404, "Not found");
}
