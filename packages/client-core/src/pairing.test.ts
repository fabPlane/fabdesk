import { describe, expect, test } from "bun:test";
import {
  buildPairingUrl,
  candidateBaseUrls,
  claimBaseUrls,
  parsePairingUrl,
  type PairingPayload,
} from "@fabdesk/protocol";
import { PairingRefusedError, claimFirstReachable, claimPairing } from "./pairing";

const payload: PairingPayload = {
  version: 1,
  token: "pt_abc-123",
  hosts: ["100.101.102.103", "192.168.1.24"],
  port: 47820,
  name: "maya's macbook",
};

const claimBody = {
  deviceToken: "dt_xyz",
  device: {
    id: "dev_1",
    label: "iPhone",
    platform: "ios",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: null,
  },
  core: { name: "maya's macbook", version: "0.2.0", platform: "darwin" },
};

const healthOk = () =>
  new Response(JSON.stringify({ ok: true, version: "0.2.0", pid: 42 }), {
    headers: { "content-type": "application/json" },
  });
const claimOk = () =>
  new Response(JSON.stringify(claimBody), { headers: { "content-type": "application/json" } });

describe("pairing url", () => {
  test("round-trips every field", () => {
    const parsed = parsePairingUrl(buildPairingUrl(payload));
    expect(parsed).toEqual(payload);
  });

  test("survives spaces and punctuation in the machine name", () => {
    const url = buildPairingUrl({ ...payload, name: "Ada & Co / lab #2" });
    expect(parsePairingUrl(url)?.name).toBe("Ada & Co / lab #2");
  });

  test("rejects anything that is not a pairing url", () => {
    expect(parsePairingUrl("https://fabplane.com")).toBeNull();
    expect(parsePairingUrl("fabdesk://pair?v=1&t=x")).toBeNull(); // no host or port
    expect(parsePairingUrl("fabdesk://pair?v=1&p=1&h=a")).toBeNull(); // no token
    expect(parsePairingUrl("fabdesk://pair?v=1&t=x&p=0&h=a")).toBeNull(); // port 0
  });

  test("builds base urls in order, bracketing ipv6", () => {
    expect(candidateBaseUrls(payload)).toEqual([
      "http://100.101.102.103:47820",
      "http://192.168.1.24:47820",
    ]);
    expect(candidateBaseUrls({ hosts: ["fd7a::1"], port: 4000 })).toEqual([
      "http://[fd7a::1]:4000",
    ]);
  });

  test("carries the coreId, and a relay becomes the last place to claim", () => {
    const withRelay: PairingPayload = {
      ...payload,
      hosts: ["127.0.0.1", "relay.fabplane.com"],
      kinds: ["loopback", "relay"],
      schemes: ["http", "https"],
      coreId: "core_abc",
    };
    const url = buildPairingUrl(withRelay);
    expect(url).toContain("&c=core_abc");
    expect(parsePairingUrl(url)).toEqual(withRelay);
    // The relay is never a direct candidate…
    expect(candidateBaseUrls(withRelay)).toEqual(["http://127.0.0.1:47820"]);
    // …but it is where a phone off the daemon's networks can still claim.
    expect(claimBaseUrls(withRelay)).toEqual([
      "http://127.0.0.1:47820",
      "https://relay.fabplane.com/c/core_abc",
    ]);
    // Without a coreId the relay cannot address the daemon, so it is not offered.
    const { coreId: _, ...noCore } = withRelay;
    expect(claimBaseUrls(noCore)).toEqual(["http://127.0.0.1:47820"]);
  });
});

describe("claim through a relay", () => {
  test("falls back to the relay when no direct address answers", async () => {
    const tried: string[] = [];
    const { baseUrl } = await claimFirstReachable(
      {
        ...payload,
        hosts: ["127.0.0.1", "relay-staging.example:4010"],
        kinds: ["loopback", "relay"],
        coreId: "core_abc",
      },
      {
        label: "iPhone",
        platform: "ios",
        fetch: async (url) => {
          tried.push(url);
          if (url.startsWith("http://127.")) throw new Error("connection refused");
          return url.endsWith("/health") ? healthOk() : claimOk();
        },
      },
    );
    expect(baseUrl).toBe("http://relay-staging.example:4010/c/core_abc");
    expect(tried).toEqual([
      "http://127.0.0.1:47820/health",
      "http://relay-staging.example:4010/c/core_abc/health",
      "http://relay-staging.example:4010/c/core_abc/v1/devices/pair/claim",
    ]);
  });
});

describe("claim", () => {
  test("posts the pairing token and parses the device", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const result = await claimPairing("http://host:47820/", "pt_abc", {
      label: "iPhone",
      platform: "ios",
      fetch: async (url, init) => {
        seen = { url, body: JSON.parse(String(init?.body)) };
        return new Response(JSON.stringify(claimBody), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(seen!.url).toBe("http://host:47820/v1/devices/pair/claim");
    expect(seen!.body).toEqual({ pairingToken: "pt_abc", label: "iPhone", platform: "ios" });
    expect(result.deviceToken).toBe("dt_xyz");
  });

  test("surfaces the daemon's error message", async () => {
    const attempt = claimPairing("http://host:1", "pt", {
      label: "iPhone",
      platform: "ios",
      fetch: async () =>
        new Response(JSON.stringify({ error: "pairing code expired" }), { status: 400 }),
    });
    expect(attempt).rejects.toThrow("pairing code expired");
  });

  test("falls through to the next address and keeps the first that answers", async () => {
    const tried: string[] = [];
    const { baseUrl } = await claimFirstReachable(payload, {
      label: "Pixel",
      platform: "android",
      fetch: async (url) => {
        tried.push(url);
        if (url.startsWith("http://100.")) throw new Error("network unreachable");
        return url.endsWith("/health") ? healthOk() : claimOk();
      },
    });
    // The unreachable address is probed and skipped; the claim goes only where health answered.
    expect(tried).toEqual([
      "http://100.101.102.103:47820/health",
      "http://192.168.1.24:47820/health",
      "http://192.168.1.24:47820/v1/devices/pair/claim",
    ]);
    expect(baseUrl).toBe("http://192.168.1.24:47820");
  });

  test("probes before claiming, and claims exactly once, on the first that answers", async () => {
    const tried: string[] = [];
    const { baseUrl } = await claimFirstReachable(payload, {
      label: "Pixel",
      platform: "android",
      fetch: async (url) => {
        tried.push(url);
        return url.endsWith("/health") ? healthOk() : claimOk();
      },
    });
    expect(tried).toEqual([
      "http://100.101.102.103:47820/health",
      "http://100.101.102.103:47820/v1/devices/pair/claim",
    ]);
    expect(baseUrl).toBe("http://100.101.102.103:47820");
  });

  test("a claim never reaches the daemon when no address answers /health", async () => {
    const tried: string[] = [];
    const attempt = claimFirstReachable(payload, {
      label: "Pixel",
      platform: "android",
      fetch: async (url) => {
        tried.push(url);
        throw new Error("Network request failed");
      },
    });
    await expect(attempt).rejects.toThrow(
      // The exact shape `describePairingFailure` on the phone parses: a title line, then one
      // "<url>: <reason>" per address.
      "could not reach maya's macbook\n" +
        "http://100.101.102.103:47820: Network request failed\n" +
        "http://192.168.1.24:47820: Network request failed",
    );
    expect(tried.every((u) => u.endsWith("/health"))).toBe(true);
  });

  test("skips an address that answers but is not a fabPlane daemon, or answers with an error", async () => {
    const claims: string[] = [];
    const attempt = claimFirstReachable(payload, {
      label: "Pixel",
      platform: "android",
      fetch: async (url) => {
        if (url.endsWith("/claim")) claims.push(url);
        if (url.startsWith("http://100.")) return new Response("<html>router</html>");
        return new Response("", { status: 503 });
      },
    });
    await expect(attempt).rejects.toThrow(
      "could not reach maya's macbook\n" +
        "http://100.101.102.103:47820: not a fabPlane daemon\n" +
        "http://192.168.1.24:47820: health returned 503",
    );
    expect(claims).toEqual([]);
  });

  test("a health probe that hangs is abandoned at the probe timeout", async () => {
    const attempt = claimFirstReachable(
      { ...payload, hosts: ["100.101.102.103"] },
      {
        label: "Pixel",
        platform: "android",
        probeTimeoutMs: 10,
        fetch: (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      },
    );
    await expect(attempt).rejects.toThrow("http://100.101.102.103:47820: no answer within 10 ms");
  });

  test("a refusal from a reachable daemon ends the search with the daemon's words", async () => {
    // Every address is the same machine; a second claim would only spend another attempt.
    const claims: string[] = [];
    const attempt = claimFirstReachable(payload, {
      label: "Pixel",
      platform: "android",
      fetch: async (url) => {
        if (url.endsWith("/health")) return healthOk();
        claims.push(url);
        return new Response(JSON.stringify({ error: "pairing code is not valid" }), {
          status: 400,
        });
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(PairingRefusedError);
    await expect(attempt).rejects.toThrow("pairing code is not valid");
    expect(claims).toEqual(["http://100.101.102.103:47820/v1/devices/pair/claim"]);
  });

  test("a claim that fails in transit after health answered moves on to the next address", async () => {
    const tried: string[] = [];
    const { baseUrl } = await claimFirstReachable(payload, {
      label: "Pixel",
      platform: "android",
      fetch: async (url) => {
        tried.push(url);
        if (url.endsWith("/health")) return healthOk();
        if (url.startsWith("http://100.")) throw new Error("Network request failed");
        return claimOk();
      },
    });
    expect(baseUrl).toBe("http://192.168.1.24:47820");
    expect(tried.filter((u) => u.endsWith("/claim"))).toHaveLength(2);
  });
});
