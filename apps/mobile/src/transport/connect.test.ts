import { describe, expect, test } from "bun:test";
import { findReachable, probe } from "./connect";

const health = { ok: true, version: "0.2.0", pid: 42, channel: "public", authMode: "fabplane", uptimeMs: 1000 };
const ok = () => new Response(JSON.stringify(health), { headers: { "content-type": "application/json" } });

/** Injectable timers: nothing fires until the test advances the clock. */
function fakeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    options: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = ++seq;
        timers.set(id, { at: now + ms, fn });
        return id;
      },
      clearTimeout: (handle: unknown) => {
        timers.delete(handle as number);
      },
    },
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    pending: () => timers.size,
  };
}

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

  test("gives up on an address that never answers, at the timeout", async () => {
    const clock = fakeClock();
    let aborted = false;
    const pending = probe("http://asleep:47820", {
      timeoutMs: 2500,
      ...clock.options,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    clock.advance(2499);
    expect(aborted).toBe(false);
    clock.advance(1);
    expect(aborted).toBe(true);
    expect(await pending).toBeNull();
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
    // Each probe's answer is released by hand, so the order is the test's, not the event loop's.
    const release = new Map<string, () => void>();
    const pending = findReachable(["http://tailnet", "http://lan"], {
      fetch: (url) =>
        new Promise((resolve) => {
          release.set(url, () => resolve(ok()));
        }),
    });
    await Promise.resolve();
    expect([...release.keys()]).toEqual(["http://tailnet/health", "http://lan/health"]);
    release.get("http://lan/health")!();
    await Promise.resolve();
    release.get("http://tailnet/health")!();
    expect((await pending)?.baseUrl).toBe("http://tailnet");
  });

  test("probes every address at once rather than one after another", async () => {
    // Sequential probing would cost a full timeout per sleeping address before the live one is
    // tried; all candidates must be in flight before any answers.
    const started: string[] = [];
    const release: Array<() => void> = [];
    const pending = findReachable(["http://a", "http://b", "http://c"], {
      fetch: (url) =>
        new Promise((resolve) => {
          started.push(url);
          release.push(() => resolve(ok()));
        }),
    });
    await Promise.resolve();
    expect(started).toHaveLength(3);
    for (const r of release) r();
    expect((await pending)?.baseUrl).toBe("http://a");
  });

  test("a first address that never answers loses to the timeout, and the second wins", async () => {
    const clock = fakeClock();
    const pending = findReachable(["http://asleep", "http://awake"], {
      timeoutMs: 2500,
      ...clock.options,
      fetch: (url, init) =>
        url.startsWith("http://asleep")
          ? new Promise((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            })
          : Promise.resolve(ok()),
    });
    await Promise.resolve();
    expect(clock.pending()).toBe(2); // one timeout per candidate, armed together
    clock.advance(2500);
    expect((await pending)?.baseUrl).toBe("http://awake");
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
