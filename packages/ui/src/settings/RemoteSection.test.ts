import { describe, expect, test } from "bun:test";
import type { CoreEndpoint } from "@fabdesk/protocol";
import { daemonError, endpointLabel, unreachableReason } from "./RemoteSection";

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
