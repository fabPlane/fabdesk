import { describe, expect, test } from "bun:test";
import { buildPairingUrl, parsePairingUrl } from "@fabdesk/protocol";
import { pairingUrlFromParams } from "./pair-link";

describe("pairingUrlFromParams", () => {
  test("round-trips the link the desktop generated, hosts in order", () => {
    const original = buildPairingUrl({
      version: 1,
      token: "tok_abc-XYZ",
      hosts: ["100.64.0.1", "192.168.1.24"],
      port: 47820,
      name: "Mac",
    });
    // What expo-router hands the /pair route for that URL: repeated `h` becomes an array.
    const params = {
      v: "1",
      t: "tok_abc-XYZ",
      p: "47820",
      n: "Mac",
      h: ["100.64.0.1", "192.168.1.24"],
    };
    expect(parsePairingUrl(pairingUrlFromParams(params))).toEqual(parsePairingUrl(original));
  });

  test("a single host arrives as a string, not an array", () => {
    const payload = parsePairingUrl(
      pairingUrlFromParams({ v: "1", t: "t", p: "47820", h: "10.0.0.2" }),
    );
    expect(payload?.hosts).toEqual(["10.0.0.2"]);
  });

  test("missing pieces still fail the parser rather than pairing with nothing", () => {
    expect(parsePairingUrl(pairingUrlFromParams({ v: "1", t: "t", p: "47820" }))).toBeNull();
    expect(
      parsePairingUrl(pairingUrlFromParams({ v: "1", p: "47820", h: "10.0.0.2", t: undefined })),
    ).toBeNull();
  });
});
