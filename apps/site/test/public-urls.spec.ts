import { describe, expect, it } from "vitest";

import { validatePublicUrls } from "../src/lib/config/public-urls.js";

const fixtureEnvironment = {
  PUBLIC_WAITLIST_URL: "https://example.test/waitlist",
  PUBLIC_PRIVACY_URL: "https://example.test/privacy",
};

describe("public URL validation", () => {
  it("accepts explicit HTTPS fixture URLs", () => {
    expect(() => validatePublicUrls(fixtureEnvironment)).not.toThrow();
  });

  it.each([
    ["a missing URL", { PUBLIC_WAITLIST_URL: fixtureEnvironment.PUBLIC_WAITLIST_URL }],
    ["a relative URL", { ...fixtureEnvironment, PUBLIC_PRIVACY_URL: "/privacy" }],
    ["an HTTP URL", { ...fixtureEnvironment, PUBLIC_WAITLIST_URL: "http://example.test" }],
  ])("rejects %s", (_, environment) => {
    expect(() => validatePublicUrls(environment)).toThrow("absolute HTTPS URL");
  });
});
