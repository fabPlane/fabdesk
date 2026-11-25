import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  ProductAnalytics,
  analyticsBuild,
  hashTelemetryId,
  telemetryEnabled,
  telemetryOs,
  type ProductAnalyticsIdentity,
  type ProductAnalyticsStore,
} from "../src/product-analytics";

const INSTALL_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ACCOUNT_SUBJECT = "acct_raw-subject-never-leave";
const DAY_MS = 24 * 60 * 60_000;

type PostedEvent = {
  uuid: string;
  event: string;
  timestamp: string;
  installId: string;
  properties: Record<string, unknown>;
  accountId?: string;
};

function memoryStore(init: Record<string, unknown> = {}): ProductAnalyticsStore {
  const data: Record<string, unknown> = { ...init };
  return {
    readRaw: (key) => data[key],
    writeRaw: (key, value) => {
      data[key] = value;
    },
  };
}

function capturingFetch(posts: { url: string; events: PostedEvent[] }[]) {
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = (await request.json()) as { events: PostedEvent[] };
    posts.push({ url: request.url, events: body.events });
    return new Response(JSON.stringify({ accepted: body.events.length }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  return fetchImpl;
}

function analytics(
  overrides: {
    store?: ProductAnalyticsStore;
    allowed?: () => boolean;
    identity?: () => ProductAnalyticsIdentity;
    fetchImpl?: typeof fetch;
    now?: () => number;
    env?: NodeJS.ProcessEnv;
    apiOrigin?: string;
    platform?: NodeJS.Platform;
    arch?: string;
    retryDelayMs?: number;
  } = {},
) {
  return new ProductAnalytics({
    apiOrigin: overrides.apiOrigin ?? "https://api.fabplane.com/",
    version: "0.4.15-test",
    store: overrides.store ?? memoryStore({ product_analytics_install_id: INSTALL_UUID }),
    allowed: overrides.allowed ?? (() => true),
    identity: overrides.identity ?? (() => ({ authMode: "fabplane", accountSubject: ACCOUNT_SUBJECT })),
    fetchImpl: overrides.fetchImpl ?? capturingFetch([]),
    now: overrides.now ?? (() => Date.parse("2026-01-15T12:00:00.000Z")),
    platform: overrides.platform ?? "linux",
    arch: overrides.arch ?? "x64",
    flushDelayMs: 60_000,
    retryDelayMs: overrides.retryDelayMs ?? 60_000,
    env: overrides.env ?? {},
  });
}

describe("product analytics helpers", () => {
  test("hashTelemetryId is SHA-256 hex", () => {
    expect(hashTelemetryId("install-raw")).toBe(
      createHash("sha256").update("install-raw").digest("hex"),
    );
  });

  test("kill switch treats false, 0, and off as disabled", () => {
    expect(telemetryEnabled({})).toBe(true);
    expect(telemetryEnabled({ FABDESK_TELEMETRY_ENABLED: "true" })).toBe(true);
    expect(telemetryEnabled({ FABDESK_TELEMETRY_ENABLED: "false" })).toBe(false);
    expect(telemetryEnabled({ FABDESK_TELEMETRY_ENABLED: "0" })).toBe(false);
    expect(telemetryEnabled({ FABDESK_TELEMETRY_ENABLED: "off" })).toBe(false);
    expect(telemetryEnabled({ FABDESK_TELEMETRY_ENABLED: "NO" })).toBe(false);
  });

  test("CI is off unless the switch is set explicitly", () => {
    expect(telemetryEnabled({ CI: "true" })).toBe(false);
    expect(telemetryEnabled({ CI: "1" })).toBe(false);
    expect(telemetryEnabled({ CI: "false" })).toBe(true);
    expect(telemetryEnabled({ CI: "true", FABDESK_TELEMETRY_ENABLED: "true" })).toBe(true);
    expect(telemetryEnabled({ CI: "true", FABDESK_TELEMETRY_ENABLED: "false" })).toBe(false);
  });

  test("only a compiled release build reports product events", () => {
    expect(analyticsBuild("release")).toBe(true);
    expect(analyticsBuild("dev")).toBe(false);
    expect(analyticsBuild("candidate")).toBe(false);
  });

  test("telemetryOs maps darwin/linux/win32 and folds the rest", () => {
    expect(telemetryOs("darwin")).toBe("darwin");
    expect(telemetryOs("linux")).toBe("linux");
    expect(telemetryOs("win32")).toBe("win32");
    expect(telemetryOs("freebsd")).toBe("other");
    expect(telemetryOs("android")).toBe("other");
  });
});

describe("ProductAnalytics", () => {
  test("hashed ids never leak the raw UUID or account subject", async () => {
    const posts: { url: string; events: PostedEvent[] }[] = [];
    const pa = analytics({ fetchImpl: capturingFetch(posts) });
    pa.track("project_created", { draft: true });
    await pa.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://api.fabplane.com/v1/telemetry/events");
    const payload = JSON.stringify(posts[0]);
    expect(payload).not.toContain(INSTALL_UUID);
    expect(payload).not.toContain(ACCOUNT_SUBJECT);
    const event = posts[0]!.events[0]!;
    expect(event.installId).toBe(hashTelemetryId(INSTALL_UUID));
    expect(event.accountId).toBe(hashTelemetryId(ACCOUNT_SUBJECT));
    expect(event.event).toBe("project_created");
    expect(event.properties["draft"]).toBe(true);
  });

  test("app.active is sent at most once per 24h", async () => {
    const posts: { url: string; events: PostedEvent[] }[] = [];
    const store = memoryStore({ product_analytics_install_id: INSTALL_UUID });
    let now = Date.parse("2026-01-15T12:00:00.000Z");
    const pa = analytics({ store, fetchImpl: capturingFetch(posts), now: () => now });
    pa.start();
    await pa.flush();
    expect(posts[0]!.events.map((e) => e.event)).toEqual(["app_open", "app.active"]);

    pa.start();
    await pa.flush();
    expect(posts[1]!.events.map((e) => e.event)).toEqual(["app_open"]);

    now += DAY_MS - 1;
    pa.start();
    await pa.flush();
    expect(posts[2]!.events.map((e) => e.event)).toEqual(["app_open"]);

    now += 1;
    pa.start();
    await pa.flush();
    expect(posts[3]!.events.map((e) => e.event)).toEqual(["app_open", "app.active"]);
  });

  test("opt-out and kill switch send nothing", async () => {
    const optedOut: { url: string; events: PostedEvent[] }[] = [];
    const opted = analytics({ allowed: () => false, fetchImpl: capturingFetch(optedOut) });
    opted.start();
    opted.track("ai_run", { agentId: "claude" });
    opted.track("export", { exportTool: "export_gerbers" });
    await opted.flush();
    expect(optedOut).toEqual([]);

    for (const value of ["false", "0", "off"] as const) {
      const killed: { url: string; events: PostedEvent[] }[] = [];
      const pa = analytics({
        fetchImpl: capturingFetch(killed),
        env: { FABDESK_TELEMETRY_ENABLED: value },
      });
      pa.start();
      pa.track("project_created");
      await pa.flush();
      expect(killed).toEqual([]);
    }
  });

  test("silent retry when offline then posts the batch", async () => {
    const posts: { url: string; events: PostedEvent[] }[] = [];
    let fail = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (fail) throw new Error("offline");
      return capturingFetch(posts)(input, init);
    };
    const pa = analytics({ fetchImpl, identity: () => ({ authMode: "local" }) });
    pa.track("ai_run", { agentId: "claude" });
    pa.track("export", { exportTool: "export_gerbers" });
    await pa.flush();
    expect(posts).toEqual([]);
    fail = false;
    await pa.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://api.fabplane.com/v1/telemetry/events");
    expect(posts[0]!.events.map((e) => e.event)).toEqual(["ai_run", "export"]);
    expect(posts[0]!.events[0]!.properties["agentId"]).toBe("claude");
    expect(posts[0]!.events[1]!.properties["exportTool"]).toBe("export_gerbers");
    expect(posts[0]!.events[0]!).not.toHaveProperty("accountId");
  });

  test("dropPending discards the queue so flush sends nothing", async () => {
    const posts: { url: string; events: PostedEvent[] }[] = [];
    const pa = analytics({ fetchImpl: capturingFetch(posts) });
    pa.track("project_created", { draft: true });
    pa.dropPending();
    await pa.flush();
    expect(posts).toEqual([]);
  });

  test("omit accountId when signed out", async () => {
    const posts: { url: string; events: PostedEvent[] }[] = [];
    const pa = analytics({
      fetchImpl: capturingFetch(posts),
      identity: () => ({ authMode: "fabplane" }),
    });
    pa.track("app_open");
    await pa.flush();
    expect(posts[0]!.events).toHaveLength(1);
    expect(posts[0]!.events[0]!).not.toHaveProperty("accountId");
    expect(posts[0]!.events[0]!.properties["authMode"]).toBe("fabplane");
  });

  test("posts allowlisted events to {apiOrigin}/v1/telemetry/events", async () => {
    const posts: { url: string; events: PostedEvent[] }[] = [];
    const pa = analytics({
      apiOrigin: "https://staging.api.fabplane.com///",
      fetchImpl: capturingFetch(posts),
    });
    pa.start();
    pa.track("project_created", { draft: true });
    pa.track("ai_run", { agentId: "claude" });
    pa.track("export", { exportTool: "export_gerbers" });
    await pa.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("https://staging.api.fabplane.com/v1/telemetry/events");
    expect(posts[0]!.events.map((e) => e.event)).toEqual([
      "app_open",
      "app.active",
      "project_created",
      "ai_run",
      "export",
    ]);
    const byName = Object.fromEntries(posts[0]!.events.map((e) => [e.event, e]));
    expect(byName["project_created"]!.properties["draft"]).toBe(true);
    expect(byName["ai_run"]!.properties["agentId"]).toBe("claude");
    expect(byName["export"]!.properties["exportTool"]).toBe("export_gerbers");
  });

  test("opt-out during in-flight failed send then opt-in sends only the new event", async () => {
    const posts: { url: string; events: PostedEvent[] }[] = [];
    let allowed = true;
    let releaseFirst: (err: unknown) => void = () => undefined;
    let firstStarted!: () => void;
    const firstStartedP = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let calls = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      calls += 1;
      if (calls === 1) {
        firstStarted();
        return new Promise((_, reject) => {
          releaseFirst = reject;
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        });
      }
      return capturingFetch(posts)(input, init);
    };
    const pa = analytics({ fetchImpl, allowed: () => allowed });
    pa.track("project_created", { draft: true });
    const inflight = pa.flush();
    await firstStartedP;
    pa.dropPending();
    allowed = false;
    releaseFirst(new Error("failed"));
    await inflight;
    allowed = true;
    pa.track("ai_run", { agentId: "claude" });
    await pa.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.events.map((e) => e.event)).toEqual(["ai_run"]);
  });

  test("last-active is persisted only once the API accepts app.active", async () => {
    const store = memoryStore({ product_analytics_install_id: INSTALL_UUID });
    const posts: { url: string; events: PostedEvent[] }[] = [];
    let fail = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (fail) throw new Error("offline");
      return capturingFetch(posts)(input, init);
    };
    const first = analytics({ store, fetchImpl });
    first.start();
    await first.flush();
    expect(store.readRaw("product_analytics_last_active_at")).toBeUndefined();
    // Same process: the queued heartbeat is not queued twice.
    first.start();
    first.dropPending();

    // Next launch after a failed send: the heartbeat goes out again and is then recorded.
    fail = false;
    const second = analytics({ store, fetchImpl });
    second.start();
    await second.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.events.map((e) => e.event)).toEqual(["app_open", "app.active"]);
    expect(store.readRaw("product_analytics_last_active_at")).toBe("2026-01-15T12:00:00.000Z");
  });

  test("a failed send is retried on a timer without another event", async () => {
    const posts: { url: string; events: PostedEvent[] }[] = [];
    let fail = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (fail) throw new Error("offline");
      return capturingFetch(posts)(input, init);
    };
    const pa = analytics({ fetchImpl, retryDelayMs: 5 });
    pa.track("app_open");
    await pa.flush();
    expect(posts).toEqual([]);
    fail = false;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.events.map((e) => e.event)).toEqual(["app_open"]);
  });

  test("a batch the API rejects as malformed is dropped, not resent", async () => {
    const posts: { url: string; events: PostedEvent[] }[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "invalid_request" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return capturingFetch(posts)(input, init);
    };
    const pa = analytics({ fetchImpl, retryDelayMs: 5 });
    pa.track("project_created");
    await pa.flush();
    pa.track("ai_run", { agentId: "claude" });
    await pa.flush();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.events.map((e) => e.event)).toEqual(["ai_run"]);
  });

  test("last-active is not written when nothing is queued", () => {
    const denied = memoryStore({ product_analytics_install_id: INSTALL_UUID });
    analytics({ store: denied, allowed: () => false }).start();
    expect(denied.readRaw("product_analytics_last_active_at")).toBeUndefined();

    const killed = memoryStore({ product_analytics_install_id: INSTALL_UUID });
    analytics({
      store: killed,
      env: { FABDESK_TELEMETRY_ENABLED: "false" },
    }).start();
    expect(killed.readRaw("product_analytics_last_active_at")).toBeUndefined();
  });

  test("posts go through FabplaneClient with Accept and no Authorization", async () => {
    const captured: { url: string; accept: string | null; authorization: string | null }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      captured.push({
        url: request.url,
        accept: request.headers.get("accept"),
        authorization: request.headers.get("authorization"),
      });
      return new Response(JSON.stringify({ accepted: 1 }), {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    };
    const pa = analytics({
      apiOrigin: "https://api.fabplane.com/",
      fetchImpl,
    });
    pa.track("app_open");
    await pa.flush();
    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://api.fabplane.com/v1/telemetry/events");
    expect(captured[0]!.accept).toBe("application/json");
    expect(captured[0]!.authorization).toBeNull();
  });
});
