import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { CoreHttpError } from "./CoreClient";
import {
  CoreOfflineError,
  DirectTransport,
  ProxyTransport,
  RELAY_CLOSE_CORE_OFFLINE,
  isCoreOffline,
  relayBaseUrl,
  relaySaysCoreOffline,
} from "./transport";
import type { WebSocketLike } from "./ws";

const CORE = "core_abcdefghijkl";
const PROJECT = {
  id: "p1",
  name: "Blinky",
  path: "/p/Blinky",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
};

/**
 * A stub relay: `/c/<coreId>/<path>` answers with what it saw (so the test can check the prefix
 * and the auth header survived), `/c/<coreId>/ws` accepts a socket and pushes one event after the
 * subscribe frame. Anything else is 404, and an unknown core is 503 like the real one.
 */
type Seen = { method: string; path: string; auth: string | null };
let relay: ReturnType<typeof Bun.serve>;
let seen: Seen[] = [];
let wsSubscribes: string[] = [];

beforeAll(() => {
  relay = Bun.serve<{ coreId: string }, Record<never, never>>({
    port: 0,
    fetch(req, server) {
      const url = new URL(req.url);
      const m = /^\/c\/([^/]+)(\/.*)$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      if (m[1] !== CORE) return Response.json({ error: "core offline" }, { status: 503 });
      if (m[2] === "/ws" && req.headers.get("upgrade") === "websocket") {
        return server.upgrade(req, { data: { coreId: m[1] } })
          ? undefined
          : new Response("no", { status: 400 });
      }
      seen.push({
        method: req.method,
        path: m[2] + url.search,
        auth: req.headers.get("authorization"),
      });
      if (m[2] === "/health")
        return Response.json({ ok: true, version: "t", pid: 1, coreId: CORE });
      if (m[2] === "/projects") return Response.json([PROJECT]);
      return Response.json({ error: "not found" }, { status: 404 });
    },
    websocket: {
      message(ws, msg) {
        wsSubscribes.push(String(msg));
        ws.send(
          JSON.stringify({
            id: 3,
            event: { topic: "thread.created", ts: 1, threadId: "th_1", projectId: null },
          }),
        );
      },
    },
  });
});
afterAll(() => relay.stop(true));

const relayUrl = () => `http://127.0.0.1:${relay.port}`;

describe("relayBaseUrl", () => {
  test("prefixes the core id and keeps a path prefix, without a trailing slash", () => {
    expect(relayBaseUrl("https://relay.fabplane.com/", CORE)).toBe(
      `https://relay.fabplane.com/c/${CORE}`,
    );
    expect(relayBaseUrl("https://fabplane.com/relay", CORE)).toBe(
      `https://fabplane.com/relay/c/${CORE}`,
    );
  });
});

describe("ProxyTransport", () => {
  test("is a proxy-kind transport whose HTTP goes through /c/<coreId> with the device token", async () => {
    seen = [];
    const t = new ProxyTransport({
      id: "conn1",
      relayUrl: relayUrl() + "/",
      coreId: CORE,
      token: "dt_1",
    });
    expect(t.kind).toBe("proxy");
    expect(t.baseUrl()).toBe(`${relayUrl()}/c/${CORE}`);
    expect(t.authHeaders()).toEqual({ Authorization: "Bearer dt_1" });
    expect(t.relayUrl).toBe(relayUrl());
    expect(t.coreId).toBe(CORE);

    expect(await t.client().health()).toMatchObject({ ok: true, coreId: CORE });
    expect(await t.client().listProjects()).toEqual([PROJECT]);
    // `/health` is unauthenticated on purpose (it is the reachability probe); the rest carries the token.
    expect(seen).toEqual([
      { method: "GET", path: "/health", auth: null },
      { method: "GET", path: "/projects", auth: "Bearer dt_1" },
    ]);
    t.dispose();
  });

  test("a core the relay does not know surfaces as a distinct CoreOfflineError, not a plain 503", async () => {
    const states: string[] = [];
    const t = new ProxyTransport({
      id: "c",
      relayUrl: relayUrl(),
      coreId: "core_unknownxxxx",
      token: "dt",
      onCoreState: (s) => states.push(s),
    });
    expect(t.coreOffline).toBe(false);
    const err = await t
      .client()
      .listProjects()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isCoreOffline(err)).toBe(true);
    expect(err).toBeInstanceOf(CoreOfflineError);
    expect(err).toBeInstanceOf(CoreHttpError);
    expect((err as CoreOfflineError).status).toBe(503);
    expect((err as CoreOfflineError).path).toBe("/projects");
    expect((err as Error).message).toMatch(/not connected/);
    expect(t.coreOffline).toBe(true);
    // The same verdict twice is one notification; it flips back on the next daemon answer.
    await t
      .client()
      .health()
      .catch(() => {});
    expect(states).toEqual(["offline"]);
  });

  test("a 503 the daemon itself produced is not mistaken for the relay's", async () => {
    // A fetch that answers 503 with a body that is not the relay's `{error:"core offline"}`.
    const t = new ProxyTransport({
      id: "c",
      relayUrl: "https://relay.example",
      coreId: CORE,
      token: "dt",
      fetch: async () => new Response(JSON.stringify({ error: "router busy" }), { status: 503 }),
    });
    const err = await t
      .client()
      .listProjects()
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isCoreOffline(err)).toBe(false);
    expect((err as CoreHttpError).status).toBe(503);
    expect(t.coreOffline).toBe(false);
  });

  test("the event socket closing with 4503 marks the core offline; the next open clears it", () => {
    const sockets: WebSocketLike[] = [];
    const factory = (): WebSocketLike => {
      const ws: WebSocketLike = {
        onopen: null,
        onerror: null,
        onclose: null,
        onmessage: null,
        send() {},
        close() {},
      };
      sockets.push(ws);
      return ws;
    };
    const states: string[] = [];
    const t = new ProxyTransport({
      id: "a",
      relayUrl: "https://relay.fabplane.com",
      coreId: CORE,
      token: "dt",
      webSocketFactory: factory,
      onCoreState: (s) => states.push(s),
    });
    const sub = t.openEvents({ topics: ["thread.*"], onEvent: () => {} });
    expect(sockets).toHaveLength(1);
    sockets[0]!.onclose?.({ code: RELAY_CLOSE_CORE_OFFLINE, reason: "core offline" });
    expect(t.coreOffline).toBe(true);
    // The daemon dialled back in and the reconnect opened: online again.
    sockets[0]!.onopen?.({});
    expect(t.coreOffline).toBe(false);
    sub.close();
    t.dispose();
    // An ordinary close (the daemon restarting, say) says nothing about the relay's view.
    const t2 = new ProxyTransport({
      id: "b",
      relayUrl: "https://relay.fabplane.com",
      coreId: CORE,
      token: "dt",
      webSocketFactory: factory,
      onCoreState: (s) => states.push(s),
    });
    t2.openEvents({ topics: ["thread.*"], onEvent: () => {} });
    sockets[1]!.onclose?.({ code: 1006 });
    expect(t2.coreOffline).toBe(false);
    t2.dispose();
    expect(states).toEqual(["offline", "online"]);
  });
});

describe("relaySaysCoreOffline", () => {
  test("recognises the relay's two bodies, as text or parsed, and nothing else", () => {
    expect(relaySaysCoreOffline(503, '{"error":"core offline"}')).toBe(true);
    expect(relaySaysCoreOffline(503, { error: "core offline" })).toBe(true);
    expect(relaySaysCoreOffline(502, '{"error":"core disconnected"}')).toBe(true);
    expect(relaySaysCoreOffline(503, '{"error":"router busy"}')).toBe(false);
    expect(relaySaysCoreOffline(503, "Service Unavailable")).toBe(false);
    expect(relaySaysCoreOffline(200, '{"error":"core offline"}')).toBe(false);
    expect(relaySaysCoreOffline(503, null)).toBe(false);
  });

  test("opens the event stream on the relay's /c/<coreId>/ws with the same subscribe protocol", async () => {
    wsSubscribes = [];
    const t = new ProxyTransport({
      id: "conn1",
      relayUrl: relayUrl(),
      coreId: CORE,
      token: "dt_1",
    });
    const events: string[] = [];
    const statuses: string[] = [];
    const sub = t.openEvents({
      topics: ["thread.*"],
      onEvent: (e, id) => events.push(`${id}:${e.topic}`),
      onStatus: (s) => statuses.push(s),
    });
    const deadline = Date.now() + 2000;
    while (events.length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(JSON.parse(wsSubscribes[0]!)).toEqual({ subscribe: ["thread.*"] });
    expect(events).toEqual(["3:thread.created"]);
    expect(statuses).toContain("open");
    expect(sub.lastEventId).toBe("3");
    t.dispose();
    expect(sub.status).toBe("closed");
  });

  test("builds the socket URL from the relay scheme, like DirectTransport does", () => {
    const urls: string[] = [];
    const factory = (url: string): WebSocketLike => {
      urls.push(url);
      return { onopen: null, onerror: null, onclose: null, onmessage: null, send() {}, close() {} };
    };
    const proxy = new ProxyTransport({
      id: "a",
      relayUrl: "https://relay.fabplane.com",
      coreId: CORE,
      token: "dt 1",
      webSocketFactory: factory,
    });
    proxy.openEvents({ topics: ["agent.*", "thread.*"], onEvent: () => {} });
    const direct = new DirectTransport({
      id: "b",
      baseUrl: "http://100.64.0.1:47820",
      token: "dt 1",
      webSocketFactory: factory,
    });
    direct.openEvents({ topics: ["agent.*", "thread.*"], onEvent: () => {} });
    expect(urls).toEqual([
      `wss://relay.fabplane.com/c/${CORE}/ws?topics=agent.*%2Cthread.*&token=dt%201`,
      "ws://100.64.0.1:47820/ws?topics=agent.*%2Cthread.*&token=dt%201",
    ]);
    proxy.dispose();
    direct.dispose();
  });
});
