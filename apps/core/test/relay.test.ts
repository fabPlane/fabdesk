/**
 * End to end through the relay: a real daemon, the in-process relay from `apps/relay`, and a fake
 * fabplane `/v1/auth/me`. Nothing is configured on the daemon: the relay is its default (here via
 * `FABPLANE_RELAY_URL`, in production derived from the API origin), and the link comes up as soon
 * as remote access is on. A phone with a device token lists projects and receives events through
 * `/c/<coreId>/…`; the device row records which path it used.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CoreEvent,
  Device,
  Health,
  PairClaimResult,
  PairStartResult,
  RemoteStatus,
  Settings,
} from "@fabdesk/protocol";
import type { CoreServices } from "@fabdesk/tools";
import { startRelay, type RelayServer } from "../../relay/src/server";
import {
  CLOSE_UNAUTHORIZED,
  RELAY_MAX_DELAY_MS,
  RelayDefaultResolver,
  RelayLink,
  VIA_HEADER,
  backoffDelay,
  defaultRelayUrl,
  discoverRelayUrl,
  relayDialUrl,
  type RelaySocket,
} from "../src/relay";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

const SESSION = "sess-maya";
const API = "https://api.example.test";
/** The relay's `/v1/auth/me` check: only the daemon's session bearer is a user. */
const fakeAuth = async (url: string, init?: RequestInit) => {
  expect(url).toBe(`${API}/v1/auth/me`);
  const bearer = new Headers(init?.headers).get("authorization");
  return bearer === `Bearer ${SESSION}`
    ? Response.json({ user: { subject: "user_maya" } })
    : new Response(JSON.stringify({ user: null }), { status: 401 });
};

let relay: RelayServer;
let daemon: Daemon;
let coreId: string;
let deviceToken: string;
/** The daemon's fabplane session; null plays a sign-out. */
let session: string | null = SESSION;
const relayEvents: Extract<CoreEvent, { topic: "remote.relay" }>[] = [];
const REMOTE: Settings["remote"] = { enabled: true, host: "127.0.0.1", port: 47822 };

const until = async (cond: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
};

beforeAll(async () => {
  relay = startRelay({
    port: 0,
    apiOrigin: API,
    fetch: fakeAuth,
    rateLimit: false,
    requestTimeoutMs: 2000,
    log: () => {},
  });
  const home = await mkdtemp(join(tmpdir(), "fabdesk-relay-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "relay-test-token-0123456789";
  process.env["FABDESK_TAILSCALE_CLI"] = "off";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    quiet: true,
    watchProjects: false,
    relayToken: () => session,
    relayEnv: { FABPLANE_RELAY_URL: relay.url },
    services: async ({ projects, bus, store }) =>
      mockServices([], {
        projects,
        bus: { emit: (e) => bus.emit(e) },
        routeRuns: store.routeRuns,
        channel: "public",
      }) as unknown as CoreServices,
    adapters: {},
    doctor: async () => ({
      version: "t",
      channel: "public",
      bun: Bun.version,
      platform: "test",
      kicad: { found: false },
      ngspice: { found: false },
      routers: [],
      agents: [],
      warnings: [],
    }),
  });
  coreId = daemon.store.settings.coreId();
  daemon.bus.subscribe(["remote.relay"], (events) => {
    for (const ev of events) if (ev.event.topic === "remote.relay") relayEvents.push(ev.event);
  });
});

afterAll(async () => {
  await daemon.close("tests done");
  relay.stop();
});

const H = () => ({ authorization: `Bearer ${daemon.token}`, "content-type": "application/json" });
const local = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.url}${path}`, { ...init, headers: { ...H(), ...(init.headers ?? {}) } });
const viaRelay = (path: string, init: RequestInit = {}) =>
  fetch(`${relay.url}/c/${coreId}${path}`, init);
const asDevice = (path: string, init: RequestInit = {}) =>
  viaRelay(path, {
    ...init,
    headers: {
      authorization: `Bearer ${deviceToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
const health = async () => (await (await local("/health")).json()) as Health;
const remoteStatus = async () => (await (await local("/v1/remote")).json()) as RemoteStatus;
const devices = async () => (await (await local("/v1/devices")).json()) as Device[];

describe("relay link", () => {
  test("waits for remote access: off means blocked with a reason, not dialing", async () => {
    expect(daemon.relay.state()).toEqual({
      connected: false,
      url: relay.url,
      error: "remote access is off",
    });
    expect((await health()).relay).toBe("off");
    expect(relay.daemons()).toEqual([]);
    expect(daemon.relay.endpoint()).toBeNull();
  });

  test("turning remote access on dials the default relay with no URL configured", async () => {
    const res = await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ remote: REMOTE }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Settings).remote.relayUrl).toBeUndefined();
    await until(() => relay.daemons().length === 1);
    expect(relay.daemons()[0]).toMatchObject({ coreId, userId: "user_maya" });
    await until(() => daemon.relay.state()?.connected === true);
    const state = daemon.relay.state()!;
    expect(state).toMatchObject({ connected: true, url: relay.url });
    expect(state.error).toBeUndefined();
    expect(Date.parse(state.since!)).toBeGreaterThan(Date.now() - 5000);
    expect((await health()).relay).toBe("connected");
    expect((await remoteStatus()).relay).toEqual(state);
    expect(relayEvents.at(-1)).toMatchObject({ connected: true, url: relay.url });
    // The endpoint to advertise is the relay's host, https-or-not as configured…
    expect(daemon.relay.endpoint()).toEqual({
      kind: "relay",
      host: `127.0.0.1:${relay.port}`,
      hostname: "127.0.0.1",
      port: relay.port,
      scheme: "http",
      iface: "relay",
      default: false,
    });
    // …and the pairing URL carries it after the direct addresses.
    const start = (await (
      await local("/v1/devices/pair/start", { method: "POST" })
    ).json()) as PairStartResult;
    expect(start.endpoints.at(-1)).toMatchObject({
      kind: "relay",
      host: `127.0.0.1:${relay.port}`,
    });
    expect(start.endpoints.filter((e) => e.kind === "relay")).toHaveLength(1);
    expect(start.url).toContain("k=relay");
    await local("/v1/devices/pair/cancel", { method: "POST" });
  });

  test("a phone pairs and lists projects through the relay with its device token", async () => {
    const start = (await (
      await local("/v1/devices/pair/start", { method: "POST" })
    ).json()) as PairStartResult;
    const claim = await viaRelay("/v1/devices/pair/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pairingToken: start.pairingToken,
        label: "Maya's iPhone (cellular)",
        platform: "ios",
      }),
    });
    expect(claim.status).toBe(200);
    const result = (await claim.json()) as PairClaimResult;
    expect(result.core.coreId).toBe(coreId);
    deviceToken = result.deviceToken;

    const hc = (await (await viaRelay("/health")).json()) as { ok: boolean; coreId: string };
    expect(hc).toMatchObject({ ok: true, coreId });
    expect((await viaRelay("/projects")).status).toBe(401);
    const projects = await asDevice("/projects");
    expect(projects.status).toBe(200);
    expect(projects.headers.get("content-type")).toContain("application/json");
    expect(Array.isArray(await projects.json())).toBe(true);
  });

  test("the device row records the path: relay, then direct once it uses the listener", async () => {
    expect((await devices())[0]).toMatchObject({ label: "Maya's iPhone (cellular)", via: "relay" });
    const direct = await fetch(`http://${REMOTE.host}:${REMOTE.port}/v1/devices/me`, {
      headers: { authorization: `Bearer ${deviceToken}`, [VIA_HEADER]: "relay" },
    });
    expect(direct.status).toBe(200);
    // The phone's own header is ignored on a listener: the path is what the daemon saw.
    expect((await devices())[0]?.via).toBe("direct");
    // Stripping it does not lose a request body.
    const posted = await fetch(`http://${REMOTE.host}:${REMOTE.port}/threads`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deviceToken}`,
        "content-type": "application/json",
        [VIA_HEADER]: "relay",
      },
      body: JSON.stringify({ agentId: "claude", title: "direct with a forged header" }),
    });
    expect(posted.status).toBe(201);
    expect(((await posted.json()) as { title: string }).title).toBe("direct with a forged header");
    // …and a proxied request that carries a forged header is still relay.
    expect((await asDevice("/v1/devices/me", { headers: { [VIA_HEADER]: "direct" } })).status).toBe(
      200,
    );
    expect((await devices())[0]?.via).toBe("relay");
  });

  test("serves the remote app's surface only: no MCP, no shutdown, no streaming", async () => {
    expect((await asDevice("/mcp/sessions")).status).toBe(404);
    expect((await asDevice("/shutdown", { method: "POST" })).status).toBe(404);
    expect((await asDevice("/v1/devices")).status).toBe(404);
    const sse = await asDevice("/events");
    expect(sse.status).toBe(501);
    expect((await asDevice("/v1/devices/me")).status).toBe(200);
  });

  test("the proxied event socket delivers a thread.created event, and refuses a bad token", async () => {
    const wsBase = relay.url.replace(/^http/, "ws");
    const ws = new WebSocket(
      `${wsBase}/c/${coreId}/ws?topics=thread.*&token=${encodeURIComponent(deviceToken)}`,
    );
    const frames: Array<{ id: number; event: { topic: string; threadId?: string } }> = [];
    ws.onmessage = (ev) => frames.push(JSON.parse(String(ev.data)));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket failed"));
    });
    ws.send(JSON.stringify({ subscribe: ["thread.*"] }));
    await until(() => relay.daemons()[0]?.clients === 1);

    const created = await asDevice("/threads", {
      method: "POST",
      body: JSON.stringify({ agentId: "claude", title: "over the relay" }),
    });
    expect(created.status).toBe(201);
    const thread = (await created.json()) as { id: string };
    await until(() => frames.some((f) => f.event.topic === "thread.created"));
    expect(frames.find((f) => f.event.topic === "thread.created")?.event.threadId).toBe(thread.id);

    // Resubscribing with a cursor replays what was missed — the same path as the listener's own `/ws`.
    const lastId = frames.at(-1)!.id;
    frames.length = 0;
    ws.send(JSON.stringify({ subscribe: ["thread.*"], lastEventId: lastId - 1 }));
    await until(() => frames.length >= 1);
    expect(frames[0]!.id).toBe(lastId);

    ws.close();
    await until(() => relay.daemons()[0]?.clients === 0);

    const bad = new WebSocket(`${wsBase}/c/${coreId}/ws?token=nope`);
    const code = await new Promise<number>((resolve) => (bad.onclose = (ev) => resolve(ev.code)));
    expect(code).toBe(CLOSE_UNAUTHORIZED);
  });

  test("`remote.relay: off` hangs up; phones get 503 until it is back on", async () => {
    const before = relayEvents.length;
    await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ remote: { ...REMOTE, relay: "off" } }),
    });
    await until(() => relay.daemons().length === 0);
    expect(daemon.relay.state()).toBeNull();
    expect((await health()).relay).toBe("off");
    expect((await remoteStatus()).relay).toBeNull();
    expect(relayEvents.slice(before)).toEqual([
      expect.objectContaining({ connected: false, url: relay.url, error: "relay link stopped" }),
    ]);
    expect((await asDevice("/projects")).status).toBe(503);

    await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ remote: { ...REMOTE, relay: "auto" } }),
    });
    await until(() => relay.daemons().length === 1);
    expect((await asDevice("/projects")).status).toBe(200);
  });

  test("an explicit relayUrl wins over the default, and clearing it goes back", async () => {
    const other = startRelay({
      port: 0,
      apiOrigin: API,
      fetch: fakeAuth,
      rateLimit: false,
      log: () => {},
    });
    try {
      await local("/settings", {
        method: "PATCH",
        body: JSON.stringify({ remote: { ...REMOTE, relayUrl: other.url } }),
      });
      await until(() => other.daemons().length === 1 && relay.daemons().length === 0);
      await until(() => daemon.relay.state()?.connected === true);
      expect(daemon.relay.state()?.url).toBe(other.url);
      await local("/settings", {
        method: "PATCH",
        body: JSON.stringify({ remote: { ...REMOTE, relayUrl: "" } }),
      });
      await until(() => relay.daemons().length === 1 && other.daemons().length === 0);
      await until(() => daemon.relay.state()?.connected === true);
      expect(daemon.relay.state()?.url).toBe(relay.url);
    } finally {
      other.stop();
    }
  });

  test("signing out pauses the link; signing back in resumes it", async () => {
    session = null;
    daemon.relay.apply(daemon.store.settings.get().remote);
    await until(() => relay.daemons().length === 0);
    expect(daemon.relay.state()).toMatchObject({ connected: false, error: "not signed in" });
    expect(relayEvents.at(-1)).toMatchObject({ connected: false, error: "not signed in" });
    expect((await health()).relay).toBe("off");
    session = SESSION;
    daemon.relay.apply(daemon.store.settings.get().remote);
    await until(() => daemon.relay.state()?.connected === true);
    expect((await asDevice("/health")).status).toBe(200);
  });

  test("a relay that drops the socket is redialled with backoff; the drop is remembered", async () => {
    // Replacing the daemon from the relay's side closes the current link with 4000.
    const impostor = new WebSocket(`${relay.url.replace(/^http/, "ws")}/d?coreId=${coreId}`, {
      headers: { authorization: `Bearer ${SESSION}` },
    } as never);
    await new Promise<void>((r) => (impostor.onopen = () => r()));
    await until(() => daemon.relay.state()?.connected === false);
    expect((await health()).relay).toBe("connecting");
    expect(daemon.relay.endpoint()).toBeNull();
    impostor.close();
    // The link comes back on its own (first retry after ~1 s).
    await until(() => daemon.relay.state()?.connected === true, 5000);
    expect(daemon.relay.state()?.lastError).toBeDefined();
    expect((await asDevice("/health")).status).toBe(200);
  });
});

describe("relay defaults", () => {
  test("defaultRelayUrl: env override, api.<domain> → relay.<domain>, else none with a reason", () => {
    expect(defaultRelayUrl("https://api.fabplane.com", {})).toEqual({
      url: "wss://relay.fabplane.com",
      source: "derived",
    });
    expect(defaultRelayUrl("http://api.local.test:4000/", {})).toEqual({
      url: "ws://relay.local.test:4000",
      source: "derived",
    });
    expect(
      defaultRelayUrl("https://api.fabplane.com", { FABPLANE_RELAY_URL: " wss://relay.dev " }),
    ).toEqual({ url: "wss://relay.dev", source: "env" });
    expect(defaultRelayUrl("https://api.fabplane.com", { FABPLANE_RELAY_URL: "" })).toMatchObject({
      url: null,
      reason: expect.stringContaining("FABPLANE_RELAY_URL is empty"),
    });
    expect(defaultRelayUrl("http://fabplane-staging.tail4f6a7.ts.net:4000", {})).toMatchObject({
      url: null,
      reason:
        "no relay is published for http://fabplane-staging.tail4f6a7.ts.net:4000; set FABPLANE_RELAY_URL to use one",
    });
    expect(defaultRelayUrl("nonsense", {})).toMatchObject({
      url: null,
      reason: expect.stringContaining("not a URL"),
    });
  });

  test("discoverRelayUrl reads /v1/config and tolerates an API without it", async () => {
    const calls: string[] = [];
    const answer =
      (body: unknown, status = 200) =>
      async (url: string | URL | Request) => {
        calls.push(String(url));
        return new Response(JSON.stringify(body), { status });
      };
    expect(
      await discoverRelayUrl("https://api.test/", answer({ relayUrl: "wss://r.test" }) as never),
    ).toBe("wss://r.test");
    expect(calls).toEqual(["https://api.test/v1/config"]);
    expect(
      await discoverRelayUrl("https://api.test", answer({ relay: { url: "wss://r2" } }) as never),
    ).toBe("wss://r2");
    expect(await discoverRelayUrl("https://api.test", answer({ relay: null }) as never)).toBeNull();
    expect(
      await discoverRelayUrl("https://api.test", answer({ error: "nope" }, 404) as never),
    ).toBeNull();
    expect(
      await discoverRelayUrl("https://api.test", (async () => {
        throw new Error("ECONNREFUSED");
      }) as never),
    ).toBeNull();
  });

  test("RelayDefaultResolver probes the API only when nothing is derivable, and once per window", async () => {
    let now = 0;
    let published: string | null = null;
    let probes = 0;
    const fetchImpl = (async () => {
      probes += 1;
      return Response.json({ relayUrl: published });
    }) as unknown as typeof fetch;
    let changes = 0;
    const derived = new RelayDefaultResolver({
      apiOrigin: "https://api.fabplane.com",
      env: {},
      fetchImpl,
    });
    expect(derived.current()).toEqual({ url: "wss://relay.fabplane.com", source: "derived" });
    await derived.settled();
    expect(probes).toBe(0);

    const staging = new RelayDefaultResolver({
      apiOrigin: "http://staging.test:4000",
      env: {},
      fetchImpl,
      onChange: () => (changes += 1),
      retryAfterMs: 1000,
      now: () => now,
    });
    expect(staging.current().url).toBeNull();
    await staging.settled();
    expect(probes).toBe(1);
    // Nothing published yet: the same answer, and no second probe inside the window.
    expect(staging.current().url).toBeNull();
    await staging.settled();
    expect(probes).toBe(1);
    expect(changes).toBe(0);
    now = 1000;
    published = "wss://relay-staging.test";
    expect(staging.current().url).toBeNull();
    await staging.settled();
    expect(probes).toBe(2);
    expect(changes).toBe(1);
    expect(staging.current()).toEqual({ url: "wss://relay-staging.test", source: "api" });
    // An env opt-out is respected: no probe at all.
    const off = new RelayDefaultResolver({
      apiOrigin: "http://staging.test:4000",
      env: { FABPLANE_RELAY_URL: "" },
      fetchImpl,
    });
    expect(off.current().url).toBeNull();
    await off.settled();
    expect(probes).toBe(2);
  });

  test("backoffDelay doubles from 1 s, jitters ±25 %, and is hard-capped at 60 s", () => {
    expect(backoffDelay(1, { random: () => 0.5 })).toBe(1000);
    expect(backoffDelay(2, { random: () => 0.5 })).toBe(2000);
    expect(backoffDelay(4, { random: () => 0 })).toBe(6000);
    expect(backoffDelay(4, { random: () => 1 })).toBe(10_000);
    expect(backoffDelay(7, { random: () => 1 })).toBe(RELAY_MAX_DELAY_MS);
    expect(backoffDelay(50, { random: () => 1 })).toBe(RELAY_MAX_DELAY_MS);
    expect(backoffDelay(3, { base: 10, max: 25, random: () => 1 })).toBe(25);
  });
});

describe("RelayLink", () => {
  test("relayDialUrl maps a setting to the /d endpoint and an advertisable endpoint", () => {
    expect(relayDialUrl("https://relay.fabplane.com/", "core_abc")).toEqual({
      url: "wss://relay.fabplane.com/d?coreId=core_abc",
      endpoint: {
        kind: "relay",
        host: "relay.fabplane.com",
        hostname: "relay.fabplane.com",
        port: 443,
        scheme: "https",
        iface: "relay",
        default: false,
      },
    });
    expect(relayDialUrl("http://10.0.0.5:4040/relay", "core_abc")).toMatchObject({
      url: "ws://10.0.0.5:4040/relay/d?coreId=core_abc",
      endpoint: { port: 4040, scheme: "http" },
    });
    expect(relayDialUrl("not a url", "core_abc")).toMatchObject({
      error: expect.stringContaining("not a URL"),
    });
    expect(relayDialUrl("ftp://x", "core_abc")).toMatchObject({
      error: expect.stringContaining("http"),
    });
  });

  test("uses the default relay, waits for a sign-in, presents the bearer, reports, and stops cleanly", () => {
    const dials: Array<{ url: string; headers: Record<string, string> }> = [];
    const events: CoreEvent[] = [];
    let token: string | null = null;
    let clock = Date.parse("2026-09-13T10:00:00Z");
    const sockets: RelaySocket[] = [];
    const link = new RelayLink({
      coreId: "core_abc",
      token: () => token,
      defaultRelay: () => defaultRelayUrl("https://api.fabplane.com", {}),
      emit: (e) => events.push(e),
      now: () => clock,
      socketFactory: (url, headers) => {
        dials.push({ url, headers });
        const s: RelaySocket = {
          readyState: 0,
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          send() {},
          close() {},
        };
        sockets.push(s);
        return s;
      },
    });
    link.attach({ fetch: async () => new Response("x"), openEvents: () => null });
    const remote: Settings["remote"] = { enabled: true, host: "0.0.0.0", port: 1 };
    expect(link.apply({ ...remote, enabled: false })).toEqual({
      connected: false,
      url: "wss://relay.fabplane.com",
      error: "remote access is off",
    });
    expect(link.apply(remote)).toEqual({
      connected: false,
      url: "wss://relay.fabplane.com",
      error: "not signed in",
    });
    expect(link.phase()).toBe("off");
    expect(link.endpoint()).toBeNull();
    expect(dials).toEqual([]);
    expect(link.apply({ ...remote, relay: "off" })).toBeNull();
    expect(link.state()).toBeNull();

    token = "sess";
    expect(link.apply(remote)).toEqual({
      connected: false,
      url: "wss://relay.fabplane.com",
      since: "2026-09-13T10:00:00.000Z",
    });
    expect(link.phase()).toBe("connecting");
    expect(dials).toEqual([
      {
        url: "wss://relay.fabplane.com/d?coreId=core_abc",
        headers: { authorization: "Bearer sess" },
      },
    ]);
    // Not advertised until it is actually up.
    expect(link.endpoint()).toBeNull();
    // Re-applying the same setting does not redial.
    link.apply(remote);
    expect(dials).toHaveLength(1);
    clock += 1500;
    sockets[0]!.readyState = 1;
    sockets[0]!.onopen?.({});
    expect(link.state()).toEqual({
      connected: true,
      url: "wss://relay.fabplane.com",
      since: "2026-09-13T10:00:01.500Z",
    });
    expect(link.phase()).toBe("connected");
    expect(link.endpoint()?.host).toBe("relay.fabplane.com");
    expect(events).toEqual([
      { topic: "remote.relay", ts: clock, connected: true, url: "wss://relay.fabplane.com" },
    ]);

    // A drop is reported with its reason and remembered as lastError across the redial.
    clock += 1000;
    sockets[0]!.onclose?.({ code: 4000, reason: "replaced" });
    expect(link.state()).toEqual({
      connected: false,
      url: "wss://relay.fabplane.com",
      since: "2026-09-13T10:00:02.500Z",
      lastError: "replaced",
    });
    expect(link.phase()).toBe("connecting");
    expect(events.at(-1)).toMatchObject({ connected: false, error: "replaced" });

    // An explicit URL replaces the default and starts over.
    expect(link.apply({ ...remote, relayUrl: "https://relay.test" })).toMatchObject({
      connected: false,
      url: "https://relay.test",
    });
    expect(link.state()?.lastError).toBeUndefined();
    expect(dials.at(-1)?.url).toBe("wss://relay.test/d?coreId=core_abc");
    expect(link.apply({ ...remote, relayUrl: "ftp://nope" })).toMatchObject({
      connected: false,
      url: "ftp://nope",
      error: expect.stringContaining("http"),
    });

    link.stop();
    expect(link.state()).toBeNull();
    expect(link.phase()).toBe("off");
    // A close after stop is ignored: no redial.
    const before = dials.length;
    sockets.at(-1)!.onclose?.({ code: 1006 });
    expect(dials).toHaveLength(before);
  });

  test("with no derivable default and nothing configured the link explains itself", () => {
    const link = new RelayLink({
      coreId: "core_abc",
      token: () => "sess",
      defaultRelay: () => defaultRelayUrl("http://fabplane-staging.tail4f6a7.ts.net:4000", {}),
    });
    expect(link.apply({ enabled: true, host: "0.0.0.0", port: 1 })).toEqual({
      connected: false,
      url: "",
      error:
        "no relay is published for http://fabplane-staging.tail4f6a7.ts.net:4000; set FABPLANE_RELAY_URL to use one",
    });
    expect(link.phase()).toBe("off");
  });
});
