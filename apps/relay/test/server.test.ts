import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RateLimiter } from "../src/rate-limit";
import { CLOSE_CORE_OFFLINE, CLOSE_REPLACED, startRelay, type RelayServer } from "../src/server";
import { API, CORE, FakeDaemon, fakeAuth, waitForClosed } from "./helpers";

let relay: RelayServer;

beforeAll(() => {
  relay = startRelay({
    port: 0,
    apiOrigin: API,
    fetch: fakeAuth,
    rateLimit: false,
    requestTimeoutMs: 500,
    log: () => {},
  });
});
afterAll(() => relay.stop());

describe("daemon side", () => {
  test("needs a valid bearer and a well-formed coreId", async () => {
    expect((await new FakeDaemon(relay, "nope").connect()).ok).toBe(false);
    expect((await new FakeDaemon(relay, "sess-maya", "not-a-core").connect()).ok).toBe(false);
    expect(relay.daemons()).toEqual([]);
    const res = await fetch(`${relay.url}/d?coreId=${CORE}`, {
      headers: { authorization: "Bearer sess-maya" },
    });
    expect(res.status).toBe(426);
  });

  test("registers, is replaced by a newer socket from the same user, refuses another user", async () => {
    const first = new FakeDaemon(relay, "sess-maya");
    expect((await first.connect()).ok).toBe(true);
    expect(relay.daemons()).toMatchObject([{ coreId: CORE, userId: "user_maya", clients: 0 }]);

    const other = new FakeDaemon(relay, "sess-jo");
    expect((await other.connect()).ok).toBe(false);
    expect(relay.daemons()).toHaveLength(1);

    const second = new FakeDaemon(relay, "sess-maya");
    expect((await second.connect()).ok).toBe(true);
    expect(await first.closed()).toBe(CLOSE_REPLACED);
    expect(relay.daemons()).toHaveLength(1);
    second.ws.close();
    await second.closed();
    // A replaced daemon's close must not evict its replacement — and the replacement's own close does.
    await Bun.sleep(20);
    expect(relay.daemons()).toEqual([]);
  });
});

describe("client side", () => {
  test("503 while no daemon is connected", async () => {
    const res = await fetch(`${relay.url}/c/${CORE}/projects`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "core offline" });
    expect((await fetch(`${relay.url}/c/bogus/projects`)).status).toBe(404);
    expect((await fetch(`${relay.url}/nothing`)).status).toBe(404);
    expect(((await (await fetch(`${relay.url}/health`)).json()) as { ok: boolean }).ok).toBe(true);
  });

  test("proxies an HTTP request as one open/resp pair, headers and body intact", async () => {
    const daemon = new FakeDaemon(relay, "sess-maya");
    await daemon.connect();
    const req = fetch(`${relay.url}/c/${CORE}/threads?limit=2`, {
      method: "POST",
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "hi" }),
    });
    const open = await daemon.answer(201, { id: "th_1" }, { "x-extra": "yes" });
    expect(open).toMatchObject({
      t: "open",
      method: "POST",
      path: "/threads?limit=2",
      headers: { authorization: "Bearer dev-token", "content-type": "application/json" },
      body: JSON.stringify({ title: "hi" }),
      bodyEncoding: "utf8",
    });
    expect((open as { headers: Record<string, string> }).headers["host"]).toBeUndefined();
    const res = await req;
    expect(res.status).toBe(201);
    expect(res.headers.get("x-extra")).toBe("yes");
    expect(await res.json()).toEqual({ id: "th_1" });

    // A GET carries no body; a binary answer comes back byte-exact.
    const bin = fetch(`${relay.url}/c/${CORE}/projects/p/files/board.png`);
    const f = await daemon.next();
    expect(f).toMatchObject({ t: "open", method: "GET", path: "/projects/p/files/board.png" });
    expect((f as { body?: string }).body).toBeUndefined();
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 255]);
    daemon.send({
      t: "resp",
      sid: f.sid,
      status: 200,
      headers: { "content-type": "image/png" },
      body: Buffer.from(bytes).toString("base64"),
      bodyEncoding: "base64",
    });
    const binRes = await bin;
    expect(binRes.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await binRes.arrayBuffer())).toEqual(bytes);
    daemon.ws.close();
    await daemon.closed();
  });

  test("refuses oversized bodies and times out a silent daemon", async () => {
    const small = startRelay({
      port: 0,
      apiOrigin: API,
      fetch: fakeAuth,
      rateLimit: false,
      maxBodyBytes: 16,
      requestTimeoutMs: 100,
      log: () => {},
    });
    try {
      const daemon = new FakeDaemon(small, "sess-maya");
      await daemon.connect();
      const big = await fetch(`${small.url}/c/${CORE}/x`, { method: "POST", body: "x".repeat(17) });
      expect(big.status).toBe(413);
      expect(daemon.frames).toEqual([]);
      const slow = await fetch(`${small.url}/c/${CORE}/slow`);
      expect(slow.status).toBe(504);
      // A daemon that drops mid-request fails the request instead of leaving it hanging.
      const dropped = fetch(`${small.url}/c/${CORE}/dropped`);
      await daemon.next();
      await daemon.next();
      daemon.ws.close();
      expect((await dropped).status).toBe(502);
    } finally {
      small.stop();
    }
  });

  test("proxies a WebSocket: ws-open with the client's auth, messages both ways, close either side", async () => {
    const daemon = new FakeDaemon(relay, "sess-maya");
    await daemon.connect();
    const client = new WebSocket(
      `${relay.url.replace("http", "ws")}/c/${CORE}/ws?topics=thread.*`,
      {
        headers: { authorization: "Bearer dev-token" },
      } as never,
    );
    const received: string[] = [];
    client.onmessage = (ev) => received.push(String(ev.data));
    await new Promise<void>((r) => (client.onopen = () => r()));
    const open = await daemon.next();
    expect(open).toMatchObject({
      t: "ws-open",
      path: "/ws?topics=thread.*",
      headers: { authorization: "Bearer dev-token" },
    });
    expect(relay.daemons()[0]?.clients).toBe(1);

    client.send(JSON.stringify({ subscribe: ["thread.*"] }));
    expect(await daemon.next()).toEqual({
      t: "ws-msg",
      sid: open.sid,
      data: JSON.stringify({ subscribe: ["thread.*"] }),
    });
    daemon.send({ t: "ws-msg", sid: open.sid, data: "hello" });
    await Bun.sleep(20);
    expect(received).toEqual(["hello"]);

    // Client closes: the daemon hears `close` and the relay forgets the sid.
    client.close();
    expect(await daemon.next()).toEqual({ t: "close", sid: open.sid });
    await Bun.sleep(10);
    expect(relay.daemons()[0]?.clients).toBe(0);

    // Daemon closes a socket it rejected: the client sees the daemon's code.
    const second = new WebSocket(`${relay.url.replace("http", "ws")}/c/${CORE}/ws`);
    const closed = waitForClosed(second);
    const open2 = await daemon.next();
    daemon.send({ t: "close", sid: open2.sid, code: 4401, reason: "unauthorized" });
    expect(await closed).toBe(4401);

    // Daemon goes away entirely: every proxied client is closed with the offline code.
    const third = new WebSocket(`${relay.url.replace("http", "ws")}/c/${CORE}/ws`);
    const thirdClosed = waitForClosed(third);
    await daemon.next();
    daemon.ws.close();
    expect(await thirdClosed).toBe(CLOSE_CORE_OFFLINE);
    await Bun.sleep(10);
    expect(relay.daemons()).toEqual([]);
  });

  test("rate-limits per source address", async () => {
    const strict = startRelay({
      port: 0,
      apiOrigin: API,
      fetch: fakeAuth,
      rateLimit: { capacity: 2, perSecond: 0.001 },
      log: () => {},
    });
    try {
      const statuses = [];
      for (let i = 0; i < 3; i++) statuses.push((await fetch(`${strict.url}/c/${CORE}/x`)).status);
      expect(statuses).toEqual([503, 503, 429]);
    } finally {
      strict.stop();
    }
  });
});

describe("RateLimiter", () => {
  test("bursts to capacity, then refills over time", () => {
    let now = 0;
    const rl = new RateLimiter(3, 1, () => now);
    expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("a")]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(rl.take("b")).toBe(true);
    now = 1000;
    expect(rl.take("a")).toBe(true);
    expect(rl.take("a")).toBe(false);
    now = 100_000;
    expect(rl.take("c")).toBe(true);
    expect(rl.size).toBe(1);
  });
});
