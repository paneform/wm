import { error } from "@sveltejs/kit";

export function isPlaygroundPath(path: string): boolean {
  return path === "/wm/play" || path.startsWith("/wm/play/");
}

export function requirePlayground(env: Readonly<Record<string, string | undefined>>): void {
  if (!playgroundEnabled(env)) {
    error(404, "Not found");
  }
}

export function playgroundEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.PLAYGROUND_ENABLED === "true" && env.VERCEL_ENV !== "production";
}
