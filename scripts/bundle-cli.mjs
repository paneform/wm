import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = process.argv[2];
if (outfile === undefined) throw new Error("usage: node scripts/bundle-cli.mjs OUTFILE");

await build({
  entryPoints: [`${root}/packages/node-host/src/cli.ts`],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24.0",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  outfile,
});
