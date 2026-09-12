import { describe, expect, test } from "bun:test";
import { describePairingFailure } from "./pairing-failure";

describe("describePairingFailure", () => {
  test("an unreachable computer tells the user to check the tailnet, and keeps the addresses", () => {
    const e = new Error(
      "could not reach Mac\nhttp://100.100.208.115:47820: Network request failed\nhttp://10.197.1.118:47820: Network request failed",
    );
    const f = describePairingFailure(e);
    expect(f.title).toBe("Can't reach Mac");
    expect(f.message).toContain("same Tailscale tailnet as Mac");
    expect(f.message).toContain("new pairing code");
    expect(f.message).toContain("http://100.100.208.115:47820: Network request failed");
    expect(f.message).toContain("http://10.197.1.118:47820: Network request failed");
  });

  test("a stale or used code says so rather than blaming the network", () => {
    for (const msg of ["no pairing in progress", "pairing code is not valid"]) {
      const f = describePairingFailure(new Error(msg));
      expect(f.title).toBe("That pairing code is no longer valid");
      expect(f.message).toContain("Pair a device");
    }
  });

  test("anything else passes through", () => {
    expect(describePairingFailure(new Error("pairing failed (500)"))).toEqual({
      title: "Pairing failed",
      message: "pairing failed (500)",
    });
    expect(describePairingFailure("boom").message).toBe("boom");
  });
});
