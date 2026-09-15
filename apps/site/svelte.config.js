import adapter from "@sveltejs/adapter-vercel";

/** @type {import("@sveltejs/kit").Config} */
const config = {
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
