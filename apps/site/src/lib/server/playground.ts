import { error } from "@sveltejs/kit";

export function isPlaygroundPath(path: string): boolean {
  return path === "/wm/play" || path.startsWith("/wm/play/");
}

export function requirePlayground(env: Readonly<Record<string, string | undefined>>): void {
  if (env.PLAYGROUND_ENABLED !== "true" || env.VERCEL_ENV === "production") {
    error(404, "Not found");
  }
}
