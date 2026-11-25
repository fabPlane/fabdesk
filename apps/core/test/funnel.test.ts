import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Funnel, pick, posthogHost, posthogKey } from "../src/funnel";
import { Store } from "../src/db";

async function openStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-funnel-"));
  return Store.open(join(dir, "core.sqlite"));
}

describe("posthog key pick", () => {
  test("runtime wins; an explicitly empty value disables a compiled-in key", () => {
    expect(pick(["phc_runtime"], ["phc_compiled"])).toBe("phc_runtime");
    expect(pick([undefined, "phc_alias"], ["phc_compiled"])).toBe("phc_alias");
    expect(pick([""], ["phc_compiled"])).toBeUndefined();
    expect(pick([undefined], ["phc_compiled"])).toBe("phc_compiled");
    expect(pick([undefined], ["  "])).toBeUndefined();
  });

  test("POSTHOG_KEY aliases and default host", () => {
    expect(posthogKey({ POSTHOG_KEY: "phc_a" })).toBe("phc_a");
    expect(posthogKey({ POSTHOG_PROJECT_API_KEY: "phc_b" })).toBe("phc_b");
    expect(posthogKey({ FABDESK_POSTHOG_KEY: "phc_c" })).toBe("phc_c");
    expect(posthogKey({ POSTHOG_KEY: "" })).toBeUndefined();
    expect(posthogHost({})).toBe("https://us.i.posthog.com");
    expect(posthogHost({ POSTHOG_HOST: "https://eu.i.posthog.com" })).toBe("https://eu.i.posthog.com");
  });
});

describe("Funnel", () => {
  test("capture is a no-op without a key and still records locally", async () => {
    const store = await openStore();
    const calls: string[] = [];
    const funnel = new Funnel({
      store,
      env: {},
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("{}", { status: 200 });
      },
    });
    expect(funnel.record("onboarding_app_launched")).toBe(true);
    expect(funnel.record("onboarding_app_launched")).toBe(false);
    await funnel.flush();
    expect(calls).toEqual([]);
    expect(funnel.snapshot().events.map((e) => e.event)).toEqual(["onboarding_app_launched"]);
    store.close();
  });

  test("adopts website ph_id, aliases a minted anon id, and identifies by subject", async () => {
    const store = await openStore();
    const bodies: Array<Record<string, unknown>> = [];
    const funnel = new Funnel({
      store,
      env: { POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://example.i.posthog.com" },
      now: () => new Date("2026-11-25T00:00:00.000Z"),
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      },
    });
    const minted = funnel.distinctId();
    expect(minted.startsWith("anon_")).toBe(true);
    funnel.adopt({
      phId: "ph_landing",
      utmSource: "google",
      utmCampaign: "try",
      gclid: "Cjw",
      referrer: "https://news.example/path",
    });
    expect(funnel.distinctId()).toBe("ph_landing");
    funnel.identify("user_subject");
    await funnel.flush();
    expect(bodies.some((b) => b.event === "$create_alias")).toBe(true);
    const alias = bodies.find((b) => b.event === "$create_alias")!;
    expect(alias.distinct_id).toBeUndefined();
    const aliasProps = alias.properties as { alias: string; distinct_id: string };
    expect(aliasProps.distinct_id).toBe(minted);
    expect(aliasProps.alias).toBe("ph_landing");
    const identify = bodies.find((b) => b.event === "$identify")!;
    expect(identify.distinct_id).toBeUndefined();
    const props = identify.properties as {
      distinct_id: string;
      $anon_distinct_id: string;
      $set_once: Record<string, string>;
    };
    expect(props.distinct_id).toBe("user_subject");
    expect(props.$anon_distinct_id).toBe("ph_landing");
    expect(props.$set_once).toEqual({
      utm_source: "google",
      utm_campaign: "try",
      gclid: "Cjw",
      referrer: "https://news.example/path",
    });
    expect(funnel.snapshot().events.some((e) => e.event === "onboarding_signed_in")).toBe(true);
    funnel.resetIdentity();
    expect(funnel.identifiedSubject()).toBeNull();
    expect(funnel.distinctId().startsWith("anon_")).toBe(true);
    expect(funnel.distinctId()).not.toBe(minted);
    expect(funnel.handoff()).toMatchObject({
      phId: "ph_landing",
      utmSource: "google",
      utmCampaign: "try",
    });
    store.close();
  });

  test("record forwards allow-listed source and drops other keys", async () => {
    const store = await openStore();
    const bodies: Array<Record<string, unknown>> = [];
    const funnel = new Funnel({
      store,
      env: { POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://example.i.posthog.com" },
      now: () => new Date("2026-11-25T00:00:00.000Z"),
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      },
    });
    expect(
      funnel.record("onboarding_first_review_viewed", { source: "review", path: "/secret.kicad_pcb" }),
    ).toBe(true);
    expect(funnel.record("onboarding_first_board_viewed", { source: "schematic" })).toBe(true);
    await funnel.flush();
    const review = bodies.find((b) => b.event === "onboarding_first_review_viewed")!;
    const reviewProps = review.properties as Record<string, unknown>;
    expect(review.distinct_id).toBeUndefined();
    expect(reviewProps["distinct_id"]).toBe(funnel.distinctId());
    expect(reviewProps["source"]).toBe("review");
    expect(reviewProps["path"]).toBeUndefined();
    const board = bodies.find((b) => b.event === "onboarding_first_board_viewed")!;
    expect((board.properties as Record<string, unknown>)["source"]).toBeUndefined();
    store.close();
  });

  test("capture retries 5xx and network errors three times, not 4xx; local once stays", async () => {
    const store = await openStore();
    const statuses: number[] = [];
    const funnel5xx = new Funnel({
      store,
      env: { POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://example.i.posthog.com" },
      fetch: async () => {
        statuses.push(503);
        return new Response("no", { status: 503 });
      },
    });
    expect(funnel5xx.record("onboarding_app_launched")).toBe(true);
    await funnel5xx.flush();
    expect(statuses).toEqual([503, 503, 503]);
    expect(funnel5xx.snapshot().events.map((e) => e.event)).toEqual(["onboarding_app_launched"]);

    const four: number[] = [];
    const funnel4xx = new Funnel({
      store,
      env: { POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://example.i.posthog.com" },
      fetch: async () => {
        four.push(400);
        return new Response("no", { status: 400 });
      },
    });
    expect(funnel4xx.record("onboarding_first_project")).toBe(true);
    await funnel4xx.flush();
    expect(four).toEqual([400]);
    expect(funnel4xx.snapshot().events.map((e) => e.event)).toEqual([
      "onboarding_app_launched",
      "onboarding_first_project",
    ]);

    const net: number[] = [];
    const funnelNet = new Funnel({
      store,
      env: { POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://example.i.posthog.com" },
      fetch: async () => {
        net.push(1);
        throw new Error("ECONNRESET");
      },
    });
    expect(funnelNet.record("onboarding_first_ai_run")).toBe(true);
    await funnelNet.flush();
    expect(net).toEqual([1, 1, 1]);
    store.close();
  });

  test("later ph_id does not replace first-touch anonymous id", async () => {
    const store = await openStore();
    const bodies: Array<Record<string, unknown>> = [];
    const funnel = new Funnel({
      store,
      env: { POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://example.i.posthog.com" },
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      },
    });
    funnel.adopt({ phId: "ph_first", utmSource: "google" });
    expect(funnel.distinctId()).toBe("ph_first");
    funnel.adopt({ phId: "ph_second", utmCampaign: "try" });
    await funnel.flush();
    expect(funnel.distinctId()).toBe("ph_first");
    expect(funnel.handoff()).toMatchObject({ phId: "ph_first", utmSource: "google", utmCampaign: "try" });
    expect(bodies.some((b) => b.event === "$create_alias")).toBe(false);
    store.close();
  });

  test("opted-out alias persists the website id locally without capturing", async () => {
    const store = await openStore();
    store.settings.patch({ productAnalytics: false });
    const bodies: Array<Record<string, unknown>> = [];
    const funnel = new Funnel({
      store,
      env: { POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://example.i.posthog.com" },
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response("{}", { status: 200 });
      },
    });
    const minted = funnel.distinctId();
    expect(minted.startsWith("anon_")).toBe(true);
    funnel.adopt({ phId: "ph_landing" });
    await funnel.flush();
    expect(funnel.distinctId()).toBe("ph_landing");
    expect(bodies).toEqual([]);
    store.close();
  });

  test("productAnalytics off skips record and capture", async () => {
    const store = await openStore();
    store.settings.patch({ productAnalytics: false });
    const calls: string[] = [];
    const funnel = new Funnel({
      store,
      env: { POSTHOG_KEY: "phc_test" },
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("{}", { status: 200 });
      },
    });
    expect(funnel.record("onboarding_app_launched")).toBe(false);
    funnel.identify("someone");
    await funnel.flush();
    expect(calls).toEqual([]);
    expect(funnel.snapshot().events).toEqual([]);
    store.close();
  });

  test("noteTool maps board tools without leaking paths", async () => {
    const store = await openStore();
    const funnel = new Funnel({ store, env: {} });
    funnel.noteTool("mcp__fabdesk__circuit_build");
    funnel.noteTool("route_run");
    funnel.noteTool("board_review");
    funnel.noteTool("project_import_kicad");
    expect(funnel.snapshot().events.map((e) => e.event).sort()).toEqual([
      "onboarding_first_board_built",
      "onboarding_first_kicad_import",
      "onboarding_first_project",
      "onboarding_first_review_viewed",
      "onboarding_first_route",
    ]);
    await funnel.flush();
    store.close();
  });
});
