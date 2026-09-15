import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const siteRoot = fileURLToPath(new URL("..", import.meta.url));

describe("social metadata", () => {
  it("declares complete Open Graph and Twitter card metadata", async () => {
    const component = await readFile(`${siteRoot}/src/lib/hero/SocialMetadata.svelte`, "utf8");
    for (const field of [
      "og:title",
      "og:description",
      "og:type",
      "og:url",
      "og:site_name",
      "og:image",
      "og:image:width",
      "og:image:height",
      "og:image:alt",
      "twitter:card",
      "twitter:title",
      "twitter:description",
      "twitter:image",
      "twitter:image:alt",
    ]) {
      expect(component).toContain(`"${field}"`);
    }
    expect(component).toContain("https://paneform.com/social/paneform-wm.png");
    expect(component).toContain("summary_large_image");
  });

  it("uses canonical URLs with trailing slashes", async () => {
    const routes = await Promise.all([
      readFile(`${siteRoot}/src/routes/wm/+page.svelte`, "utf8"),
      readFile(`${siteRoot}/src/routes/wm/waitlist/+page.svelte`, "utf8"),
    ]);
    expect(routes[0]).toContain('canonical="https://paneform.com/wm/"');
    expect(routes[1]).toContain('canonical="https://paneform.com/wm/waitlist/"');
  });
});
