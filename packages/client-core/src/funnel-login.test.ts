import { describe, expect, test } from "bun:test";
import { CoreClient } from "./CoreClient";
import { appendFunnelToLoginUrl, funnelHandoffFromLoginSearch } from "./funnel-login";

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
    expect(calls).toEqual([
      { url: "http://127.0.0.1:47831/funnel", body: null },
      {
        url: "http://127.0.0.1:47831/funnel/handoff",
        method: "POST",
        body: { phId: "ph1", utmSource: "google" },
      },
    ]);
  });
});
