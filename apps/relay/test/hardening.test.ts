import { describe, expect, test } from "bun:test";
import { AuthCache } from "../src/auth-cache";
import { HeldQueue } from "../src/flow";
import { shortHash } from "../src/hash";
import { DaemonLedger } from "../src/limits";
import { redact } from "../src/log";
import { Metrics } from "../src/metrics";
import {
  CLOSE_IDLE,
  CLOSE_RESTARTING,
  CLOSE_TRY_AGAIN_LATER,
  startRelay,
  type RelayOptions,
  type RelayServer,
} from "../src/server";
import {
  API,
  CORE,
  FakeDaemon,
  fakeAuth,
  makeFakeAuth,
  openClient,
  until,
  waitForClosed,
  wsUrl,
} from "./helpers";
import { RawWebSocket } from "./raw-ws";

type LogLine = { level: string; msg: string; data: Record<string, unknown> };

const start = (extra: Partial<RelayOptions> = {}, lines?: LogLine[]) =>
  startRelay({
    port: 0,
    apiOrigin: API,
    fetch: fakeAuth,
    rateLimit: false,
    requestTimeoutMs: 500,
    idle: false,
    log: lines ? (level, msg, data) => lines.push({ level, msg, data: data ?? {} }) : () => {},
    ...extra,
  });

const withRelay = async (
  extra: Partial<RelayOptions>,
  fn: (relay: RelayServer, lines: LogLine[]) => Promise<void>,
) => {
  const lines: LogLine[] = [];
  const relay = start(extra, lines);
  try {
    await fn(relay, lines);
  } finally {
    relay.stop();
  }
};

const metricsText = async (relay: RelayServer) =>
  await (await fetch(`${relay.url}/metrics`)).text();
const metricValue = (text: string, line: string) => {
  const m = new RegExp(`^${line.replace(/[{}"]/g, (c) => `\\${c}`)} (\\d+)$`, "m").exec(text);
  return m ? Number(m[1]) : null;
};

describe("auth cache", () => {
  test("reuses a verdict for the TTL, then asks the API again", async () => {
    const calls: Array<string | undefined> = [];
    await withRelay(
      { fetch: makeFakeAuth((b) => calls.push(b)), authCacheTtlMs: 150 },
      async (relay) => {
        const first = new FakeDaemon(relay, "sess-maya");
        expect((await first.connect()).ok).toBe(true);
        const second = new FakeDaemon(relay, "sess-maya");
        expect((await second.connect()).ok).toBe(true);
        expect(await first.closed()).toBeGreaterThan(0);
        expect(calls).toEqual(["sess-maya"]);

        // Negative verdicts are cached too: a bad bearer retrying does not hammer the API.
        expect((await new FakeDaemon(relay, "nope").connect()).ok).toBe(false);
        expect((await new FakeDaemon(relay, "nope").connect()).ok).toBe(false);
        expect(calls).toEqual(["sess-maya", "nope"]);

        await Bun.sleep(170);
        const third = new FakeDaemon(relay, "sess-maya");
        expect((await third.connect()).ok).toBe(true);
        expect(calls).toEqual(["sess-maya", "nope", "sess-maya"]);
        const text = await metricsText(relay);
        expect(metricValue(text, 'relay_auth_cache_total{result="hit"}')).toBe(2);
        expect(metricValue(text, 'relay_auth_cache_total{result="miss"}')).toBe(3);
        expect(metricValue(text, "relay_auth_checks_total")).toBe(3);
      },
    );
  });

  test("an API outage is not cached", async () => {
    let down = true;
    const flaky: RelayOptions["fetch"] = async (url, init) =>
      down ? new Response("boom", { status: 500 }) : fakeAuth(url, init);
    await withRelay({ fetch: flaky }, async (relay) => {
      expect((await new FakeDaemon(relay, "sess-maya").connect()).ok).toBe(false);
      down = false;
      expect((await new FakeDaemon(relay, "sess-maya").connect()).ok).toBe(true);
      expect(
        metricValue(await metricsText(relay), 'relay_rejections_total{reason="auth_unavailable"}'),
      ).toBe(1);
    });
  });

  test("AuthCache keeps hashed keys, expires, and bounds its size", () => {
    let now = 0;
    const cache = new AuthCache(1000, 2, () => now);
    cache.set("a", { userId: "u1" });
    cache.set("b", { userId: null });
    expect(cache.get("a")).toEqual({ userId: "u1" });
    expect(cache.get("b")).toEqual({ userId: null });
    cache.set("c", { userId: "u3" }); // full: the oldest entry goes
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    now = 1001;
    expect(cache.get("c")).toBeUndefined();
    expect(cache.size).toBe(1);
    expect(new AuthCache(0).get("a")).toBeUndefined();
  });
});

describe("per-user limits", () => {
  test("caps distinct cores per user; replacing the same core is free", async () => {
    await withRelay({ limits: { maxDaemonsPerUser: 1 } }, async (relay) => {
      const a = new FakeDaemon(relay, "sess-maya", "core_aaaaaaaaaaaa");
      expect((await a.connect()).ok).toBe(true);
      const b = new FakeDaemon(relay, "sess-maya", "core_bbbbbbbbbbbb");
      expect((await b.connect()).ok).toBe(false);
      const a2 = new FakeDaemon(relay, "sess-maya", "core_aaaaaaaaaaaa");
      expect((await a2.connect()).ok).toBe(true);
      // Another user is unaffected.
      const jo = new FakeDaemon(relay, "sess-jo", "core_jojojojojojo");
      expect((await jo.connect()).ok).toBe(true);
      expect(
        relay
          .daemons()
          .map((d) => d.coreId)
          .sort(),
      ).toEqual(["core_aaaaaaaaaaaa", "core_jojojojojojo"]);
      a2.ws.close();
      await a2.closed();
      await until(() => relay.daemons().length === 1);
      expect((await new FakeDaemon(relay, "sess-maya", "core_bbbbbbbbbbbb").connect()).ok).toBe(
        true,
      );
      expect(
        metricValue(await metricsText(relay), 'relay_rejections_total{reason="too_many_daemons"}'),
      ).toBe(1);
    });
  });

  test("caps phone sockets per core", async () => {
    await withRelay({ limits: { maxClientsPerCore: 2 } }, async (relay) => {
      const daemon = new FakeDaemon(relay, "sess-maya");
      await daemon.connect();
      const c1 = await openClient(relay);
      const c2 = await openClient(relay);
      expect([c1.ok, c2.ok]).toEqual([true, true]);
      const c3 = await openClient(relay);
      expect(c3.ok).toBe(false);
      const res = await fetch(`${relay.url}/c/${CORE}/ws`, {
        headers: { upgrade: "websocket", connection: "upgrade" },
      });
      expect(res.status).toBe(429);
      c1.ws.close();
      await until(() => relay.daemons()[0]?.clients === 1);
      expect((await openClient(relay)).ok).toBe(true);
    });
  });

  test("caps proxied HTTP per minute per user, across their cores", async () => {
    await withRelay({ limits: { requestsPerMinutePerUser: 2 } }, async (relay) => {
      const a = new FakeDaemon(relay, "sess-maya", "core_aaaaaaaaaaaa");
      const b = new FakeDaemon(relay, "sess-maya", "core_bbbbbbbbbbbb");
      await a.connect();
      await b.connect();
      const r1 = fetch(`${relay.url}/c/core_aaaaaaaaaaaa/x`);
      await a.answer(200, {});
      expect((await r1).status).toBe(200);
      const r2 = fetch(`${relay.url}/c/core_bbbbbbbbbbbb/x`);
      await b.answer(200, {});
      expect((await r2).status).toBe(200);
      const r3 = await fetch(`${relay.url}/c/core_aaaaaaaaaaaa/x`);
      expect(r3.status).toBe(429);
      expect(await r3.json()).toEqual({ error: "rate limited" });
      expect(a.frames).toEqual([]);
      // WebSocket upgrades are not counted against the HTTP budget.
      expect((await openClient(relay, "/c/core_aaaaaaaaaaaa/ws")).ok).toBe(true);
    });
  });

  test("DaemonLedger counts distinct cores per user", () => {
    const l = new DaemonLedger();
    expect(l.allows("u", "c1", 1)).toBe(true);
    l.add("u", "c1");
    expect(l.allows("u", "c1", 1)).toBe(true);
    expect(l.allows("u", "c2", 1)).toBe(false);
    expect(l.allows("v", "c2", 1)).toBe(true);
    l.remove("u", "c1");
    expect(l.count("u")).toBe(0);
    expect(l.users).toBe(0);
  });
});

describe("health, metrics and logs", () => {
  test("/health reports counts and uptime, never identifiers", async () => {
    await withRelay({}, async (relay) => {
      const daemon = new FakeDaemon(relay, "sess-maya");
      await daemon.connect();
      await openClient(relay);
      const body = (await (await fetch(`${relay.url}/health`)).json()) as Record<string, unknown>;
      expect(body).toEqual({ ok: true, uptimeSeconds: expect.any(Number), daemons: 1, clients: 1 });
      expect(JSON.stringify(body)).not.toContain(CORE);
      expect(JSON.stringify(body)).not.toContain("user_maya");
    });
  });

  test("/metrics is Prometheus text with connections, frames, bytes and rejections", async () => {
    await withRelay({}, async (relay) => {
      expect((await fetch(`${relay.url}/c/${CORE}/x`)).status).toBe(503);
      const daemon = new FakeDaemon(relay, "sess-maya");
      await daemon.connect();
      const req = fetch(`${relay.url}/c/${CORE}/x`, { method: "POST", body: "hello" });
      await daemon.answer(200, { ok: 1 });
      await req;
      const { ws } = await openClient(relay);
      ws.send("ping-from-phone");
      const open = await daemon.next();
      await daemon.next();
      daemon.send({ t: "ws-msg", sid: open.sid, data: "to-phone" });
      await Bun.sleep(20);

      const res = await fetch(`${relay.url}/metrics`);
      expect(res.headers.get("content-type")).toContain("text/plain");
      const text = await res.text();
      expect(text).toContain("# TYPE relay_daemons_connected gauge");
      expect(metricValue(text, "relay_daemons_connected")).toBe(1);
      expect(metricValue(text, "relay_clients_connected")).toBe(1);
      expect(metricValue(text, "relay_daemon_connections_total")).toBe(1);
      expect(metricValue(text, "relay_client_sockets_total")).toBe(1);
      expect(metricValue(text, "relay_http_requests_total")).toBe(1);
      expect(metricValue(text, 'relay_rejections_total{reason="core_offline"}')).toBe(1);
      // open + ws-open + ws-msg went to the daemon; resp + ws-msg came back.
      expect(metricValue(text, 'relay_frames_total{direction="to_daemon"}')).toBe(3);
      expect(metricValue(text, 'relay_frames_total{direction="from_daemon"}')).toBe(2);
      expect(metricValue(text, 'relay_frames_total{direction="from_client"}')).toBe(1);
      expect(metricValue(text, 'relay_frames_total{direction="to_client"}')).toBe(1);
      expect(metricValue(text, 'relay_bytes_total{direction="to_client"}')).toBe("to-phone".length);
      expect(text).not.toContain(CORE);
      expect(text).not.toContain("user_maya");
    });
  });

  test("logs are structured and carry hashed identifiers only", async () => {
    await withRelay({}, async (relay, lines) => {
      const daemon = new FakeDaemon(relay, "sess-maya");
      await daemon.connect();
      daemon.ws.send("not json");
      await Bun.sleep(20);
      daemon.ws.close();
      await daemon.closed();
      await until(() => lines.some((l) => l.msg === "daemon disconnected"));
      const connected = lines.find((l) => l.msg === "daemon connected")!;
      expect(connected.data).toEqual({ core: shortHash(CORE), user: shortHash("user_maya") });
      expect(connected.data["core"]).toMatch(/^[0-9a-f]{12}$/);
      const serialised = JSON.stringify(lines);
      expect(serialised).not.toContain(CORE);
      expect(serialised).not.toContain("user_maya");
      expect(lines.map((l) => l.msg)).toEqual([
        "listening",
        "daemon connected",
        "bad daemon frame",
        "daemon disconnected",
      ]);
    });
  });

  test("redact hashes coreId and userId, drops empty ones, keeps the rest", () => {
    expect(redact({ coreId: "core_x", userId: "", n: 1, error: "e" })).toEqual({
      core: shortHash("core_x"),
      n: 1,
      error: "e",
    });
    expect(redact(undefined)).toEqual({});
  });

  test("Metrics renders every family with HELP and TYPE lines", () => {
    const m = new Metrics(() => 5000);
    m.frame("to_daemon", 10);
    m.reject('weird "reason"');
    const text = m.render({
      daemons: 0,
      clients: 0,
      pending: 0,
      authCacheEntries: 0,
      shuttingDown: true,
    });
    expect(text).toContain("# HELP relay_uptime_seconds");
    expect(text).toContain("relay_shutting_down 1\n");
    expect(text).toContain('relay_rejections_total{reason="weird \\"reason\\""} 1');
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("idle timeouts", () => {
  test("a quiet daemon is pinged, and closed with 4408 if it never answers", async () => {
    await withRelay({ idle: { pingIntervalMs: 40, idleTimeoutMs: 150 } }, async (relay, lines) => {
      const raw = await RawWebSocket.connect(`${wsUrl(relay)}/d?coreId=${CORE}`, {
        Authorization: "Bearer sess-maya",
      });
      expect(raw.status).toBe(101);
      await until(() => relay.daemons().length === 1);
      const ping = await raw.frame(0x9);
      expect(ping.opcode).toBe(0x9);
      await raw.frame(0x8);
      expect(raw.closeCode()).toBe(CLOSE_IDLE);
      await until(() => relay.daemons().length === 0);
      expect(lines.some((l) => l.msg === "daemon closed: idle")).toBe(true);
      expect(metricValue(await metricsText(relay), "relay_idle_closes_total")).toBe(1);
      raw.destroy();
    });
  });

  test("a daemon that answers pings stays; a silent phone is closed", async () => {
    await withRelay({ idle: { pingIntervalMs: 40, idleTimeoutMs: 150 } }, async (relay) => {
      const daemon = new FakeDaemon(relay, "sess-maya");
      await daemon.connect();
      const phone = await RawWebSocket.connect(`${wsUrl(relay)}/c/${CORE}/ws`);
      expect(phone.status).toBe(101);
      await phone.frame(0x8);
      expect(phone.closeCode()).toBe(CLOSE_IDLE);
      await Bun.sleep(200);
      // Bun's WebSocket client pongs on its own, so the daemon outlives several idle windows.
      expect(relay.daemons()).toHaveLength(1);
      expect(daemon.closeCode).toBeNull();
      phone.destroy();
    });
  });
});

describe("backpressure", () => {
  const chunk = (tag: string, size: number) => tag + "-".repeat(size - tag.length);

  test("phone frames are held while the daemon is not reading, and flushed when it drains", async () => {
    await withRelay({ flow: { pauseAt: 64 * 1024, closeAt: 32 * 1024 * 1024 } }, async (relay) => {
      const daemon = await RawWebSocket.connect(`${wsUrl(relay)}/d?coreId=${CORE}`, {
        Authorization: "Bearer sess-maya",
      });
      await until(() => relay.daemons().length === 1);
      daemon.pause();
      const { ws: phone } = await openClient(relay);
      const total = 24;
      for (let i = 0; i < total; i++) phone.send(chunk(`m${i}:`, 256 * 1024));
      await Bun.sleep(100);
      // Some of it reached the socket buffer; the rest is held and the phone is still open.
      expect(phone.readyState).toBe(WebSocket.OPEN);
      daemon.resume();
      await until(
        () => new Array(total).fill(0).every((_, i) => daemon.text().includes(`m${i}:`)),
        10_000,
      );
      expect(phone.readyState).toBe(WebSocket.OPEN);
      // Order survives the hold.
      const positions = new Array(total).fill(0).map((_, i) => daemon.text().indexOf(`m${i}:`));
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      phone.close();
      daemon.destroy();
    });
  }, 20_000);

  test("a phone is closed with 1013 when its held bytes pass the cap", async () => {
    await withRelay({ flow: { pauseAt: 64 * 1024, closeAt: 256 * 1024 } }, async (relay, lines) => {
      const daemon = await RawWebSocket.connect(`${wsUrl(relay)}/d?coreId=${CORE}`, {
        Authorization: "Bearer sess-maya",
      });
      await until(() => relay.daemons().length === 1);
      daemon.pause();
      const { ws: phone } = await openClient(relay);
      const closed = waitForClosed(phone);
      // The first message goes straight to the daemon socket and mostly sits there (the kernel
      // takes a megabyte or so); the second cannot be held without passing the cap, so the
      // phone is closed.
      for (let i = 0; i < 3; i++) phone.send(chunk(`m${i}:`, 4 * 1024 * 1024));
      expect(await closed).toBe(CLOSE_TRY_AGAIN_LATER);
      expect(lines.some((l) => l.msg === "phone closed: daemon backpressure")).toBe(true);
      expect(metricValue(await metricsText(relay), "relay_backpressure_closes_total")).toBe(1);
      // HTTP is refused outright while the daemon is that far behind.
      const res = await fetch(`${relay.url}/c/${CORE}/x`);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "core busy" });
      daemon.destroy();
    });
  });

  test("a phone that stops reading is closed with 1013", async () => {
    await withRelay({ flow: { pauseAt: 64 * 1024, closeAt: 512 * 1024 } }, async (relay) => {
      const daemon = new FakeDaemon(relay, "sess-maya");
      await daemon.connect();
      const phone = await RawWebSocket.connect(`${wsUrl(relay)}/c/${CORE}/ws`);
      const open = await daemon.next();
      expect(open.t).toBe("ws-open");
      phone.pause();
      for (let i = 0; i < 24; i++)
        daemon.send({ t: "ws-msg", sid: open.sid, data: chunk(`m${i}:`, 256 * 1024) });
      const close = await daemon.next();
      expect(close).toEqual({ t: "close", sid: open.sid });
      await until(() => relay.daemons()[0]?.clients === 0);
      phone.resume();
      await phone.frame(0x8, 5000);
      expect(phone.closeCode()).toBe(CLOSE_TRY_AGAIN_LATER);
      phone.destroy();
    });
  });

  test("HeldQueue refuses past the cap and flushes in order until refused", () => {
    const q = new HeldQueue();
    expect(q.push("aaaa", 10)).toBe(true);
    expect(q.push("bbbb", 10)).toBe(true);
    expect(q.push("ccc", 10)).toBe(false);
    expect(q.length).toBe(2);
    expect(q.bytes).toBe(8);
    const sent: string[] = [];
    q.flush((f) => {
      if (f === "bbbb") return false;
      sent.push(f);
      return true;
    });
    expect(sent).toEqual(["aaaa"]);
    expect(q.length).toBe(1);
    expect(q.bytes).toBe(4);
    q.flush((f) => (sent.push(f), true));
    expect(sent).toEqual(["aaaa", "bbbb"]);
    expect(q.length).toBe(0);
    q.push("x", 10);
    q.clear();
    expect(q.bytes).toBe(0);
  });
});

describe("graceful shutdown", () => {
  test("stops accepting, closes phones and daemons with 1012, fails in-flight requests", async () => {
    const lines: LogLine[] = [];
    const relay = start({}, lines);
    const daemon = new FakeDaemon(relay, "sess-maya");
    await daemon.connect();
    const { ws: phone } = await openClient(relay);
    const phoneClosed = waitForClosed(phone);
    await daemon.next(); // ws-open
    const inflight = fetch(`${relay.url}/c/${CORE}/slow`);
    await daemon.next(); // open
    const done = relay.shutdown({ graceMs: 100 });
    // Until the listener goes away, new peers are turned away and health says so.
    const health = await fetch(`${relay.url}/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ ok: false, shuttingDown: true });
    expect((await fetch(`${relay.url}/c/${CORE}/x`)).status).toBe(503);
    expect((await new FakeDaemon(relay, "sess-maya").connect()).ok).toBe(false);
    const res = await inflight;
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "relay restarting" });
    expect(await phoneClosed).toBe(CLOSE_RESTARTING);
    expect(await daemon.closed()).toBe(CLOSE_RESTARTING);
    await done;
    expect(lines.some((l) => l.msg === "shutting down")).toBe(true);
    await expect(fetch(`${relay.url}/health`)).rejects.toThrow();
  });
});
