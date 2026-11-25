import { describe, expect, test } from "bun:test";
import {
  appendFunnelHandoffToUrl,
  collectFunnelHandoff,
  FunnelHandoff,
  funnelHandoffFromArgv,
  funnelHandoffFromEnv,
  funnelHandoffFromRecord,
  funnelHandoffFromSearchParams,
  mergeFunnelHandoff,
  sanitizeFunnelReferrer,
} from "../src/funnel-handoff";

describe("funnel handoff", () => {
  test("reads ph_id, UTMs, gclid and referrer aliases from query keys", () => {
    const params = new URLSearchParams({
      ph_id: "ph_landing",
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "try",
      utm_content: "hero",
      utm_term: "pcb",
      gclid: "Cjw",
      fp_referrer: "https://user:secret@news.example/path?q=1#hash",
    });
    expect(funnelHandoffFromSearchParams(params)).toEqual({
      phId: "ph_landing",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "try",
      utmContent: "hero",
      utmTerm: "pcb",
      gclid: "Cjw",
      referrer: "https://news.example/path",
    });
  });

  test("ref alias is accepted and credentials plus query are stripped", () => {
    expect(sanitizeFunnelReferrer("https://alice:pw@ex.com/a?token=1")).toBe("https://ex.com/a");
    expect(funnelHandoffFromSearchParams(new URLSearchParams({ ref: "https://ex.com/from" }))).toEqual({
      referrer: "https://ex.com/from",
    });
  });

  test("argv and fabplane:// / https download URLs supply first-touch fields", () => {
    expect(
      funnelHandoffFromArgv([
        "fabdesk-core",
        "serve",
        "fabplane://open?ph_id=from-app&utm_source=newsletter",
        "https://fabplane.com/download?gclid=abc&referrer=https://ex.com/",
      ]),
    ).toEqual({
      phId: "from-app",
      utmSource: "newsletter",
      gclid: "abc",
      referrer: "https://ex.com/",
    });
  });

  test("env aliases fill gaps only", () => {
    const env = {
      FABDESK_PH_ID: "env-id",
      FABDESK_UTM_SOURCE: "env-src",
      FABDESK_GCLID: "env-gclid",
      FABDESK_REFERRER: "https://ref.example/path?x=1",
    } as NodeJS.ProcessEnv;
    expect(funnelHandoffFromEnv(env)).toEqual({
      phId: "env-id",
      utmSource: "env-src",
      gclid: "env-gclid",
      referrer: "https://ref.example/path",
    });
    expect(
      collectFunnelHandoff({
        argv: ["https://fabplane.com/download?ph_id=site"],
        env,
      }),
    ).toEqual({
      phId: "site",
      utmSource: "env-src",
      gclid: "env-gclid",
      referrer: "https://ref.example/path",
    });
  });

  test("merge keeps first-touch values", () => {
    expect(
      mergeFunnelHandoff({ phId: "first", utmSource: "a" }, { phId: "second", utmCampaign: "b" }),
    ).toEqual({ phId: "first", utmSource: "a", utmCampaign: "b" });
  });

  test("POST body accepts camelCase or query keys", () => {
    expect(FunnelHandoff.parse({ phId: "x", utmSource: "ad" })).toEqual({ phId: "x", utmSource: "ad" });
    expect(funnelHandoffFromRecord({ ph_id: "y", utm_campaign: "c" })).toEqual({
      phId: "y",
      utmCampaign: "c",
    });
  });

  test("append onto device-login URL and nested return_to without overwriting", () => {
    const handoff = { phId: "ph1", utmSource: "google", gclid: "g1" };
    const decorated = appendFunnelHandoffToUrl(
      "https://fabplane.com/device?user_code=ABCD-EFGH&utm_source=already",
      handoff,
    );
    const url = new URL(decorated);
    expect(url.searchParams.get("user_code")).toBe("ABCD-EFGH");
    expect(url.searchParams.get("ph_id")).toBe("ph1");
    expect(url.searchParams.get("utm_source")).toBe("already");
    expect(url.searchParams.get("gclid")).toBe("g1");

    const nested = appendFunnelHandoffToUrl(
      "https://fabplane.com/login?return_to=/device?user_code=ZZ",
      { phId: "nested" },
    );
    expect(new URL(nested).searchParams.get("ph_id")).toBe("nested");
    expect(new URL(nested).searchParams.get("return_to")).toContain("ph_id=nested");
  });
});
