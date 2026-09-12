import { describe, expect, test } from "bun:test";
import {
  buildPairingUrl,
  candidateBaseUrls,
  parsePairingUrl,
  type PairingPayload,
} from "@fabdesk/protocol";
import { claimFirstReachable, claimPairing } from "./pairing";

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
        return new Response(JSON.stringify(claimBody), {
          headers: { "content-type": "application/json" },
        });
      },
    });
    expect(tried).toHaveLength(2);
    expect(baseUrl).toBe("http://192.168.1.24:47820");
  });

  test("reports every address it tried when none answer", async () => {
    const attempt = claimFirstReachable(payload, {
      label: "Pixel",
      platform: "android",
      fetch: async () => {
        throw new Error("network unreachable");
      },
    });
    expect(attempt).rejects.toThrow("could not reach maya's macbook");
  });
});
