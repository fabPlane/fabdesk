import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildPairingUrl, parsePairingUrl } from "@fabdesk/protocol";
import { migrate } from "../src/db";
import { DeviceStore, PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, hashToken } from "../src/devices";
import { isTailscaleAddress, listenAddresses } from "../src/net";

function store(): DeviceStore {
  const db = new Database(":memory:", { create: true, strict: true });
  migrate(db);
  return new DeviceStore(db);
}

describe("device tokens", () => {
  test("an issued token verifies, and is stored only as a digest", () => {
    const s = store();
    const { device, token } = s.issue("Maya's iPhone", "ios");
    expect(s.verify(token)?.id).toBe(device.id);
    expect(token).not.toBe(hashToken(token));
    expect(s.list().map((d) => d.id)).toEqual([device.id]);
  });

  test("an unknown token verifies as nothing", () => {
    const s = store();
    s.issue("phone", "ios");
    expect(s.verify("not-a-token")).toBeNull();
    expect(s.verify(null)).toBeNull();
  });

  test("revoking stops the token and hides the device", () => {
    const s = store();
    const { device, token } = s.issue("phone", "android");
    expect(s.revoke(device.id)).toBe(true);
    expect(s.verify(token)).toBeNull();
    expect(s.list()).toEqual([]);
    expect(s.revoke(device.id)).toBe(false);
  });

  test("touch records last-seen", () => {
    const s = store();
    const { device } = s.issue("phone", "ios");
    expect(s.list()[0]!.lastSeenAt).toBeNull();
    s.touch(device.id, Date.parse("2026-02-03T04:05:06.000Z"));
    expect(s.list()[0]!.lastSeenAt).toBe("2026-02-03T04:05:06.000Z");
  });
});

describe("pairing", () => {
  test("claiming consumes the token: the same code cannot be used twice", () => {
    const s = store();
    const pending = s.startPairing();
    const first = s.claim({ pairingToken: pending.token, label: "iPhone", platform: "ios" });
    expect(s.verify(first.token)?.label).toBe("iPhone");
    expect(() =>
      s.claim({ pairingToken: pending.token, label: "iPhone again", platform: "ios" }),
    ).toThrow("no pairing in progress");
    expect(s.list()).toHaveLength(1);
  });

  test("a pairing token expires", () => {
    const s = store();
    const t0 = 1_000_000;
    const pending = s.startPairing(t0);
    expect(s.pendingPairing(t0 + PAIRING_TTL_MS - 1)).not.toBeNull();
    expect(s.pendingPairing(t0 + PAIRING_TTL_MS)).toBeNull();
    expect(() =>
      s.claim({ pairingToken: pending.token, label: "x", platform: "ios" }, t0 + PAIRING_TTL_MS),
    ).toThrow("no pairing in progress");
  });

  test("a wrong code burns the pairing after a handful of attempts", () => {
    const s = store();
    const pending = s.startPairing();
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS - 1; i++) {
      expect(() => s.claim({ pairingToken: "guess", label: "x", platform: "ios" })).toThrow(
        "not valid",
      );
    }
    expect(() => s.claim({ pairingToken: "guess", label: "x", platform: "ios" })).toThrow(
      "not valid",
    );
    // The real token no longer works either: the attempt budget is spent.
    expect(() => s.claim({ pairingToken: pending.token, label: "x", platform: "ios" })).toThrow(
      "no pairing in progress",
    );
  });

  test("starting a new pairing invalidates the previous one", () => {
    const s = store();
    const first = s.startPairing();
    s.startPairing();
    expect(() => s.claim({ pairingToken: first.token, label: "x", platform: "ios" })).toThrow(
      "not valid",
    );
  });

  test("the QR url the daemon builds is the one a client parses", () => {
    const url = buildPairingUrl({
      version: 1,
      token: "pt",
      hosts: ["100.64.0.1", "192.168.0.5"],
      port: 47820,
      name: "lab",
    });
    expect(parsePairingUrl(url)?.hosts).toEqual(["100.64.0.1", "192.168.0.5"]);
  });
});

describe("listen addresses", () => {
  test("tailnet addresses are recognised and sorted first", () => {
    expect(isTailscaleAddress("100.101.102.103")).toBe(true);
    expect(isTailscaleAddress("100.128.0.1")).toBe(false); // above the /10
    expect(isTailscaleAddress("192.168.1.2")).toBe(false);

    const found = listenAddresses(47820, {
      en0: [{ address: "192.168.1.24", family: "IPv4", internal: false } as never],
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
      tailscale0: [{ address: "100.101.102.103", family: "IPv4", internal: false } as never],
      en1: [{ address: "fe80::1", family: "IPv6", internal: false } as never],
    });
    expect(found.map((e) => e.host)).toEqual(["100.101.102.103", "192.168.1.24"]);
    expect(found[0]!.kind).toBe("tailscale");
    expect(found.every((e) => e.port === 47820)).toBe(true);
  });
});
