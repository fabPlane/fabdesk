import { describe, expect, test } from "bun:test";
import { CoreClient } from "./CoreClient";
import { appendFunnelToLoginUrl, deviceLoginUrl, funnelHandoffFromLoginSearch } from "./funnel-login";

describe("funnel login URL", () => {
  test("appends missing first-touch keys onto the device-login URL", () => {
    const decorated = appendFunnelToLoginUrl("https://fabplane.com/device?user_code=ABCD-EFGH", {
      phId: "ph_abc",
      utmSource: "google",
      utmCampaign: "try",
      gclid: "Cjw",
      referrer: "https://news.example/path",
    });
    const url = new URL(decorated);
    expect(url.searchParams.get("user_code")).toBe("ABCD-EFGH");
    expect(url.searchParams.get("ph_id")).toBe("ph_abc");
    expect(url.searchParams.get("utm_source")).toBe("google");
    expect(url.searchParams.get("utm_campaign")).toBe("try");
    expect(url.searchParams.get("gclid")).toBe("Cjw");
    expect(url.searchParams.get("referrer")).toBe("https://news.example/path");
  });

  test("does not overwrite keys the site already set, including nested return_to", () => {
    const login = `https://fabplane.com/login?return_to=${encodeURIComponent("/device?ph_id=site&utm_source=ad")}`;
    const decorated = appendFunnelToLoginUrl(login, {
      phId: "desktop",
      utmSource: "other",
      utmMedium: "cpc",
    });
    const url = new URL(decorated);
    expect(url.searchParams.get("ph_id")).toBe("desktop");
    const returnTo = url.searchParams.get("return_to") ?? "";
    expect(returnTo).toContain("ph_id=site");
    expect(returnTo).toContain("utm_source=ad");
    expect(returnTo).toContain("utm_medium=cpc");
    expect(funnelHandoffFromLoginSearch(returnTo.includes("?") ? returnTo.slice(returnTo.indexOf("?")) : returnTo).phId).toBe(
      "site",
    );
  });
});

describe("CoreClient funnel", () => {
  test("getFunnel and submitFunnelHandoff hit /funnel", async () => {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    const client = new CoreClient({
      baseUrl: "http://127.0.0.1:47831",
      token: "tok",
      fetch: async (url, init) => {
        calls.push({
          url,
          ...(init?.method ? { method: init.method } : {}),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          captureEnabled: false,
          optedIn: true,
          distinctId: "anon_x",
          identifiedSubject: null,
          handoff: { phId: "ph1" },
          events: [],
        });
      },
    });
    await client.getFunnel();
    await client.submitFunnelHandoff({ phId: "ph1", utmSource: "google" });
    await client.trackFunnelEvent("onboarding_first_review_viewed", { source: "review" });
    expect(calls).toEqual([
      { url: "http://127.0.0.1:47831/funnel", body: null },
      {
        url: "http://127.0.0.1:47831/funnel/handoff",
        method: "POST",
        body: { phId: "ph1", utmSource: "google" },
      },
      {
        url: "http://127.0.0.1:47831/funnel/events",
        method: "POST",
        body: { event: "onboarding_first_review_viewed", properties: { source: "review" } },
      },
    ]);
  });

  test("deviceLoginUrl appends funnel handoff and falls back on error", async () => {
    const ok = new CoreClient({
      baseUrl: "http://127.0.0.1:47831",
      token: "tok",
      fetch: async () =>
        Response.json({
          captureEnabled: false,
          optedIn: true,
          distinctId: "anon_x",
          identifiedSubject: null,
          handoff: { phId: "ph1", utmSource: "google" },
          events: [],
        }),
    });
    const decorated = await deviceLoginUrl(ok, "https://fabplane.com/device?user_code=ABCD-EFGH");
    const url = new URL(decorated);
    expect(url.searchParams.get("user_code")).toBe("ABCD-EFGH");
    expect(url.searchParams.get("ph_id")).toBe("ph1");
    expect(url.searchParams.get("utm_source")).toBe("google");

    const failing = new CoreClient({
      baseUrl: "http://127.0.0.1:47831",
      token: "tok",
      fetch: async () => new Response("nope", { status: 500 }),
    });
    expect(await deviceLoginUrl(failing, "https://fabplane.com/device?user_code=ZZ")).toBe(
      "https://fabplane.com/device?user_code=ZZ",
    );
  });
});
