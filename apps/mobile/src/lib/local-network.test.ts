import { describe, expect, test } from "bun:test";
import { hostOf, isPrivateIPv4, warmupTargets } from "./local-network";

describe("isPrivateIPv4", () => {
  test("accepts the RFC 1918 ranges and link-local", () => {
    for (const h of [
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.9.9",
      "192.168.1.24",
      "169.254.1.1",
    ])
      expect(isPrivateIPv4(h)).toBe(true);
  });

  test("rejects tailnet (CGNAT), public and loopback addresses, and names", () => {
    for (const h of [
      "100.64.0.1",
      "100.101.102.103",
      "8.8.8.8",
      "127.0.0.1",
      "172.32.0.1",
      "172.15.0.1",
      "laptop.local",
      "",
    ])
      expect(isPrivateIPv4(h)).toBe(false);
  });
});

describe("hostOf", () => {
  test("reads the host out of a base url", () => {
    expect(hostOf("http://192.168.1.24:47820")).toBe("192.168.1.24");
    expect(hostOf("http://192.168.1.24:47820/")).toBe("192.168.1.24");
    expect(hostOf("http://laptop.local")).toBe("laptop.local");
  });

  test("gives up on ipv6 and on things that are not base urls", () => {
    expect(hostOf("http://[fd7a::1]:4000")).toBeNull();
    expect(hostOf("fabdesk://pair?v=1")).toBeNull();
  });
});

describe("warmupTargets", () => {
  test("saved private addresses come first, then the gateway guess", () => {
    expect(
      warmupTargets({
        candidates: ["http://100.64.0.1:47820", "http://192.168.1.24:47820/"],
        deviceIp: "192.168.1.7",
        port: 47820,
      }),
    ).toEqual(["http://192.168.1.24:47820", "http://192.168.1.1:47820"]);
  });

  test("a tailnet-only connection still gets a local target from the phone's own subnet", () => {
    expect(
      warmupTargets({ candidates: ["http://100.64.0.1:47820"], deviceIp: "10.1.2.3", port: 47820 }),
    ).toEqual(["http://10.1.2.1:47820"]);
  });

  test("with nothing to go on, a fixed private address keeps the prompt coming", () => {
    expect(warmupTargets({ candidates: [], deviceIp: null, port: 47820 })).toEqual([
      "http://192.168.1.1:47820",
    ]);
    // A cellular address is not local; the gateway guess would be nonsense.
    expect(warmupTargets({ candidates: [], deviceIp: "100.80.1.2", port: 47820 })).toEqual([
      "http://192.168.1.1:47820",
    ]);
  });

  test("does not repeat a target", () => {
    expect(
      warmupTargets({
        candidates: ["http://192.168.1.1:47820"],
        deviceIp: "192.168.1.9",
        port: 47820,
      }),
    ).toEqual(["http://192.168.1.1:47820"]);
  });
});
