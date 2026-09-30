import { env } from "$env/dynamic/private";
import { playgroundEnabled } from "$lib/server/playground.js";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = () => ({ playgroundEnabled: playgroundEnabled(env) });
