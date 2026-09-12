import { describe, expect, test } from "bun:test";
import { findReachable, probe } from "./connect";

const health = { ok: true, version: "0.2.0", pid: 42, channel: "public", authMode: "fabplane", uptimeMs: 1000 };
const ok = () => new Response(JSON.stringify(health), { headers: { "content-type": "application/json" } });

describe("probe", () => {
  test("accepts a healthy daemon", async () => {
    expect(await probe("http://100.64.0.1:47820/", { fetch: async () => ok() })).toMatchObject({ pid: 42 });
  });

  test("rejects a non-200, a body that is not ok, and a refused connection", async () => {
    expect(await probe("http://x", { fetch: async () => new Response("", { status: 502 }) })).toBeNull();
    expect(await probe("http://x", { fetch: async () => new Response(JSON.stringify({ ok: false })) })).toBeNull();
    expect(
      await probe("http://x", {
        fetch: async () => {
          throw new Error("connection refused");
        },
      }),
    ).toBeNull();
  });

  test("asks the right url", async () => {
    let seen = "";
    await probe("http://host:47820/", {
      fetch: async (url) => {
        seen = url;
        return ok();
      },
    });
    expect(seen).toBe("http://host:47820/health");
  });
});

describe("findReachable", () => {
  test("prefers the first address listed even when a later one answers sooner", async () => {
    const found = await findReachable(["http://tailnet", "http://lan"], {
      fetch: async (url) => {
        if (url.startsWith("http://tailnet")) {
          await new Promise((r) => setTimeout(r, 20));
          return ok();
        }
        return ok();
      },
    });
    expect(found?.baseUrl).toBe("http://tailnet");
  });

  test("falls through to an address that does answer", async () => {
    const found = await findReachable(["http://asleep", "http://awake"], {
      fetch: async (url) => {
        if (url.startsWith("http://asleep")) throw new Error("no route to host");
        return ok();
      },
    });
    expect(found?.baseUrl).toBe("http://awake");
  });

  test("gives up when nothing answers, and on an empty list", async () => {
    expect(
      await findReachable(["http://a", "http://b"], {
        fetch: async () => {
          throw new Error("no route to host");
        },
      }),
    ).toBeNull();
    expect(await findReachable([])).toBeNull();
  });
});
