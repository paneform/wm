import { afterEach, describe, expect, it, vi } from "vitest";

import { joinWaitlist } from "../src/lib/hero/waitlist.js";

afterEach(() => vi.unstubAllGlobals());

describe("Loops waitlist", () => {
  it("encodes email addresses and assigns the launch group and mailing list", async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ success: true }));
    vi.stubGlobal("fetch", request);
    await joinWaitlist("  test+launch@example.com  ");
    const [url, options] = request.mock.calls[0]!;
    expect(url).toBe("https://app.loops.so/api/newsletter-form/cmtyx917h28bf0jygmf7i7w3v");
    expect(options.method).toBe("POST");
    expect(options.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(options.body))).toEqual({
      email: "test+launch@example.com",
      userGroup: "pre-launch",
      mailingLists: "cmu08ntus3w6u0j1m8mnz0tim",
    });
  });

  it("handles rate limiting even when the response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("Too many requests", { status: 429 })),
    );
    await expect(joinWaitlist("test@example.com")).rejects.toThrow("Please wait a minute");
  });

  it.each([
    Response.json({ success: false }),
    Response.json({ success: true }, { status: 500 }),
    Response.json({}),
    new Response("Unavailable", { status: 503 }),
  ])("does not accept an unsuccessful or malformed response", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(joinWaitlist("test@example.com")).rejects.toThrow();
  });

  it("propagates network failures so the form can offer a retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(joinWaitlist("test@example.com")).rejects.toThrow();
  });
});
