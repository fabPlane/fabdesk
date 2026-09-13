/**
 * End to end through the relay: a real daemon, the in-process relay from `apps/relay`, and a fake
 * fabplane `/v1/auth/me`. A phone with a device token lists projects and receives events through
 * `/c/<coreId>/…` while the daemon's own remote listener stays off.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PairClaimResult, PairStartResult, Settings } from "@fabdesk/protocol";
import type { CoreServices } from "@fabdesk/tools";
import { startRelay, type RelayServer } from "../../relay/src/server";
import { CLOSE_UNAUTHORIZED, RelayLink, relayDialUrl, type RelaySocket } from "../src/relay";
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
const REMOTE: Settings["remote"] = { enabled: false, host: "127.0.0.1", port: 47822 };

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
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    quiet: true,
    watchProjects: false,
    relayToken: () => SESSION,
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

describe("relay link", () => {
  test("is off until relayUrl is set; setting it dials the relay without the listener being on", async () => {
    expect(daemon.relay.state()).toBeNull();
    expect(relay.daemons()).toEqual([]);
    const res = await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ remote: { ...REMOTE, relayUrl: relay.url } }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Settings).remote.relayUrl).toBe(relay.url);
    await until(() => relay.daemons().length === 1);
    expect(relay.daemons()[0]).toMatchObject({ coreId, userId: "user_maya" });
    await until(() => daemon.relay.state()?.connected === true);
    expect(daemon.relay.state()).toEqual({ connected: true, url: relay.url });
    // The listener itself stayed off: the relay is a path of its own.
    expect(fetch(`http://${REMOTE.host}:${REMOTE.port}/health`)).rejects.toThrow();
    // …and the endpoint to advertise is the relay's host, https-or-not as configured.
    expect(daemon.relay.endpoint()).toEqual({
      kind: "relay",
      host: `127.0.0.1:${relay.port}`,
      hostname: "127.0.0.1",
      port: relay.port,
      scheme: "http",
      iface: "relay",
      default: false,
    });
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

    const health = (await (await viaRelay("/health")).json()) as { ok: boolean; coreId: string };
    expect(health).toMatchObject({ ok: true, coreId });
    expect((await viaRelay("/projects")).status).toBe(401);
    const projects = await asDevice("/projects");
    expect(projects.status).toBe(200);
    expect(projects.headers.get("content-type")).toContain("application/json");
    expect(Array.isArray(await projects.json())).toBe(true);
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

  test("clearing the setting hangs up; phones get 503 until it is back", async () => {
    await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ remote: { ...REMOTE, relayUrl: null } }),
    });
    await until(() => relay.daemons().length === 0);
    expect(daemon.relay.state()).toBeNull();
    expect((await asDevice("/projects")).status).toBe(503);

    await local("/settings", {
      method: "PATCH",
      body: JSON.stringify({ remote: { ...REMOTE, relayUrl: relay.url } }),
    });
    await until(() => relay.daemons().length === 1);
    expect((await asDevice("/projects")).status).toBe(200);
  });

  test("a relay that drops the socket is redialled with backoff", async () => {
    // Replacing the daemon from the relay's side closes the current link with 4000.
    const impostor = new WebSocket(`${relay.url.replace(/^http/, "ws")}/d?coreId=${coreId}`, {
      headers: { authorization: `Bearer ${SESSION}` },
    } as never);
    await new Promise<void>((r) => (impostor.onopen = () => r()));
    await until(() => daemon.relay.state()?.connected === false);
    impostor.close();
    // The link comes back on its own (first retry after ~1 s).
    await until(() => daemon.relay.state()?.connected === true, 5000);
    expect((await asDevice("/health")).status).toBe(200);
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

  test("waits for a sign-in, presents the bearer, and stops cleanly", () => {
    const dials: Array<{ url: string; headers: Record<string, string> }> = [];
    let token: string | null = null;
    const sockets: RelaySocket[] = [];
    const link = new RelayLink({
      coreId: "core_abc",
      token: () => token,
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
    const remote: Settings["remote"] = {
      enabled: true,
      host: "0.0.0.0",
      port: 1,
      relayUrl: "https://relay.test",
    };
    expect(link.apply(remote)).toEqual({
      connected: false,
      url: "https://relay.test",
      error: "not signed in",
    });
    expect(link.endpoint()).toBeNull();
    expect(dials).toEqual([]);

    token = "sess";
    expect(link.apply(remote)).toEqual({ connected: false, url: "https://relay.test" });
    expect(dials).toEqual([
      { url: "wss://relay.test/d?coreId=core_abc", headers: { authorization: "Bearer sess" } },
    ]);
    expect(link.endpoint()?.host).toBe("relay.test");
    // Re-applying the same setting does not redial.
    link.apply(remote);
    expect(dials).toHaveLength(1);
    sockets[0]!.readyState = 1;
    sockets[0]!.onopen?.({});
    expect(link.state()).toEqual({ connected: true, url: "https://relay.test" });

    link.stop();
    expect(link.state()).toBeNull();
    // A close after stop is ignored: no redial.
    sockets[0]!.onclose?.({ code: 1006 });
    expect(dials).toHaveLength(1);
  });
});
