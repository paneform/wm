import adapter from "@sveltejs/adapter-vercel";
import { mdsvex, escapeSvelte } from "mdsvex";
import { codeToHtml } from "shiki";
import rehypeSlug from "rehype-slug";

/** @type {import("@sveltejs/kit").Config} */
const config = {
  extensions: [".svelte", ".svx"],
  preprocess: [
    mdsvex({
      extensions: [".svx"],
      rehypePlugins: [rehypeSlug],
      highlight: {
        async highlighter(code, lang = "text") {
          const html = await codeToHtml(code, {
            lang,
            themes: { dark: "rose-pine", light: "rose-pine-dawn" },
          });
          return `{@html \`${escapeSvelte(html)}\`}`;
        },
      },
    }),
  ],
  kit: {
    adapter: adapter(),
    paths: {
      relative: true,
    },
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        "connect-src": ["self", "https://app.loops.so"],
        "font-src": ["self"],
        "base-uri": ["none"],
        "object-src": ["none"],
      },
    },
  },
};

export default config;
