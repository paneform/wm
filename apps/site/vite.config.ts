import { sveltekit } from "@sveltejs/kit/vite";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

import { validatePublicUrls } from "./src/lib/config/public-urls.js";

function validateProductionEnvironment(): Plugin {
  return {
    name: "validate-production-environment",
    config(_, environment) {
      if (environment.command === "build") {
        validatePublicUrls(loadEnv(environment.mode, process.cwd(), "PUBLIC_"));
      }
    },
  };
}

export default defineConfig({
  plugins: [validateProductionEnvironment(), sveltekit()],
  test: {
    include: ["test/**/*.spec.ts"],
  },
});
