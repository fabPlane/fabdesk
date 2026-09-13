import { describe, expect, test } from "bun:test";
import type { CoreEndpoint } from "@fabdesk/protocol";
import {
  daemonError,
  durationLabel,
  endpointLabel,
  relayHostLabel,
  relayPresentation,
  unreachableReason,
} from "./RemoteSection";

const ep = (over: Partial<CoreEndpoint>): CoreEndpoint => ({
  host: "192.168.1.24",
  port: 47820,
  kind: "lan",
  iface: "en0",
  default: false,
  ...over,
});

describe("RemoteSection helpers", () => {
  test("endpointLabel shows the MagicDNS name over the IP, and https names as a URL", () => {
    expect(endpointLabel(ep({}))).toBe("192.168.1.24:47820");
    expect(
      endpointLabel(ep({ host: "100.64.0.1", kind: "tailscale", hostname: "mac.tail.ts.net" })),
    ).toBe("mac.tail.ts.net:47820");
    expect(
      endpointLabel(
        ep({
          host: "mac.tail.ts.net",
          hostname: "mac.tail.ts.net",
          port: 443,
          scheme: "https",
          kind: "tailscale-https",
        }),
      ),
    ).toBe("https://mac.tail.ts.net");
  });

  test("a served https name makes even a loopback bind reachable", () => {
    expect(
      unreachableReason({ host: "127.0.0.1" }, [ep({ host: "127.0.0.1", kind: "loopback" })]),
    ).toMatch(/only this machine/);
    expect(
      unreachableReason({ host: "127.0.0.1" }, [
        ep({ host: "mac.tail.ts.net", port: 443, scheme: "https", kind: "tailscale-https" }),
        ep({ host: "127.0.0.1", kind: "loopback" }),
      ]),
    ).toBeNull();
  });

  test("daemonError unwraps the daemon's JSON error body and leaves other messages alone", () => {
    expect(
      daemonError(
        new Error('{"error":"tailscale serve failed: HTTPS is not enabled","code":"precondition"}'),
      ),
    ).toBe("tailscale serve failed: HTTPS is not enabled");
    expect(daemonError(new Error("Failed to fetch"))).toBe("Failed to fetch");
    expect(daemonError("boom")).toBe("boom");
  });
});

describe("relay row", () => {
  const NOW = Date.parse("2026-09-13T12:00:00Z");
  const up = {
    connected: true,
    url: "wss://relay.fabplane.com",
    since: "2026-09-13T11:55:00Z",
  };

  test("relayHostLabel folds fabplane's relays into the site and keeps other hosts", () => {
    expect(relayHostLabel("wss://relay.fabplane.com")).toBe("fabplane.com");
    expect(relayHostLabel("https://relay-staging.fabplane.com/")).toBe("fabplane.com");
    expect(relayHostLabel("ws://fabplane-staging.tail4f6a7.ts.net:4041")).toBe(
      "fabplane-staging.tail4f6a7.ts.net",
    );
    expect(relayHostLabel("http://[::1]:4040")).toBe("::1");
    // Nothing known yet: the default is fabplane.com's, so say so.
    expect(relayHostLabel(null)).toBe("fabplane.com");
    expect(relayHostLabel("")).toBe("fabplane.com");
  });

  test("durationLabel", () => {
    expect(durationLabel(30_000)).toBe("<1m");
    expect(durationLabel(5 * 60_000)).toBe("5m");
    expect(durationLabel(2 * 3_600_000 + 10 * 60_000)).toBe("2h 10m");
    expect(durationLabel(3 * 3_600_000)).toBe("3h");
    expect(durationLabel(3 * 86_400_000)).toBe("3d");
  });

  test("a daemon with the switch: connected, with uptime and a Turn off button", () => {
    const p = relayPresentation(up, { relay: "auto", relayUrl: null }, NOW);
    expect(p.state).toBe("connected");
    expect(p.title).toBe("Relay via fabplane.com");
    expect(p.detail).toBe("Phones can reach this computer from anywhere · up 5m.");
    expect(p.action).toEqual({ label: "Turn off", next: "off" });
  });

  test("a daemon with the switch: not yet connected shows why, still with Turn off", () => {
    const p = relayPresentation(
      { connected: false, url: "wss://relay.fabplane.com", error: "not signed in to fabplane.com" },
      { relay: "auto" },
      NOW,
    );
    expect(p.state).toBe("connecting");
    expect(p.detail).toBe("Not connected · not signed in to fabplane.com");
    expect(p.action?.next).toBe("off");
    // A `lastError` from the previous attempt stands in when there is no current one.
    expect(
      relayPresentation(
        { connected: false, url: "wss://relay.fabplane.com", lastError: "relay closed (1012)" },
        { relay: "auto" },
        NOW,
      ).detail,
    ).toBe("Not connected · relay closed (1012)");
    expect(
      relayPresentation(
        { connected: false, url: "wss://relay.fabplane.com" },
        { relay: "auto" },
        NOW,
      ).detail,
    ).toBe("Connecting…");
  });

  test("switched off: off, whatever the status object says, and a Turn on button", () => {
    for (const relay of [null, up, { connected: false, url: "wss://relay.fabplane.com" }]) {
      const p = relayPresentation(relay, { relay: "off" }, NOW);
      expect(p.state).toBe("off");
      expect(p.action).toEqual({ label: "Turn on", next: "auto" });
    }
  });

  test("switch on but no link object yet: waiting for a sign-in", () => {
    const p = relayPresentation(null, { relay: "auto" }, NOW);
    expect(p.state).toBe("connecting");
    expect(p.detail).toMatch(/sign-in/);
    expect(p.action?.next).toBe("off");
  });

  test("a daemon without the switch (only relayUrl): no button, the override is the control", () => {
    expect(relayPresentation(null, { relayUrl: null }, NOW)).toMatchObject({
      state: "off",
      action: null,
    });
    expect(relayPresentation(null, { relayUrl: null }, NOW).detail).toMatch(/relay URL/);
    const p = relayPresentation(
      { connected: true, url: "http://127.0.0.1:4040" },
      { relayUrl: "http://127.0.0.1:4040" },
      NOW,
    );
    expect(p).toMatchObject({ state: "connected", title: "Relay via 127.0.0.1", action: null });
    // No `since` from an older daemon: no uptime, no stray separator.
    expect(p.detail).toBe("Phones can reach this computer from anywhere.");
  });

  test("a daemon that predates the relay entirely", () => {
    const p = relayPresentation(undefined, { relayUrl: null }, NOW);
    expect(p.state).toBe("unsupported");
    expect(p.action).toBeNull();
    expect(p.detail).toMatch(/Update/);
  });

  test("a since in the future, or unparseable, is not shown as uptime", () => {
    expect(
      relayPresentation({ ...up, since: "2026-09-13T12:05:00Z" }, { relay: "auto" }, NOW).detail,
    ).toBe("Phones can reach this computer from anywhere.");
    expect(relayPresentation({ ...up, since: "garbage" }, { relay: "auto" }, NOW).detail).toBe(
      "Phones can reach this computer from anywhere.",
    );
  });
});
