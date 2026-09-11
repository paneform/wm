import adapter from "@sveltejs/adapter-static";

/** @type {import("@sveltejs/kit").Config} */
const config = {
  kit: {
    adapter: adapter({
      pages: "build",
      assets: "build",
      strict: true,
    }),
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
        "connect-src": ["self"],
        "font-src": ["self"],
        "base-uri": ["none"],
        "object-src": ["none"],
      },
    },
  },
};

export default config;
