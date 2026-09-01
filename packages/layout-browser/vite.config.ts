import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2023",
    outDir: "playground-dist",
    emptyOutDir: true,
  },
});
