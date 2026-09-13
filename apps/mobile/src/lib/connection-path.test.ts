import { describe, expect, test } from "bun:test";
import {
  anyHostOf,
  classifyBaseUrl,
  connectionPath,
  pathHint,
  pathLabel,
  relayHostLabel,
  streamBannerLabel,
} from "./connection-path";

describe("anyHostOf", () => {
  test("reads the host off plain, pathed, ported, bracketed and named URLs", () => {
    expect(anyHostOf("http://192.168.1.24:47820")).toBe("192.168.1.24");
    expect(anyHostOf("https://relay.fabplane.com/c/core_abc")).toBe("relay.fabplane.com");
    expect(anyHostOf("https://mac.tail4f6a7.ts.net")).toBe("mac.tail4f6a7.ts.net");
    expect(anyHostOf("http://[fe80::1%25en0]:47820/")).toBe("fe80::1%25en0");
    expect(anyHostOf("http://127.0.0.1:4040/c/x?y=1")).toBe("127.0.0.1");
    expect(anyHostOf("fabdesk://pair?h=x")).toBeNull();
    expect(anyHostOf("")).toBeNull();
  });
});

describe("classifyBaseUrl", () => {
  test("tailnet addresses: CGNAT range and MagicDNS names, https names as tailscale-https", () => {
    expect(classifyBaseUrl("http://100.64.0.1:47820")).toBe("tailscale");
    expect(classifyBaseUrl("http://100.127.255.254:47820")).toBe("tailscale");
    expect(classifyBaseUrl("http://mac.tail4f6a7.ts.net:47820")).toBe("tailscale");
    expect(classifyBaseUrl("https://mac.tail4f6a7.ts.net")).toBe("tailscale-https");
  });

  test("private and link-local ranges are LAN; 100.x outside the CGNAT block is not a tailnet", () => {
    expect(classifyBaseUrl("http://192.168.1.24:47820")).toBe("lan");
    expect(classifyBaseUrl("http://10.0.0.5:47820")).toBe("lan");
    expect(classifyBaseUrl("http://172.16.4.2:47820")).toBe("lan");
    expect(classifyBaseUrl("http://169.254.10.1:47820")).toBe("lan");
    expect(classifyBaseUrl("http://[fe80::1]:47820")).toBe("lan");
    expect(classifyBaseUrl("http://100.20.0.1:47820")).toBe("other");
  });

  test("loopback and everything else", () => {
    expect(classifyBaseUrl("http://127.0.0.1:47820")).toBe("loopback");
    expect(classifyBaseUrl("http://localhost:47820")).toBe("loopback");
    expect(classifyBaseUrl("http://[::1]:47820")).toBe("loopback");
    expect(classifyBaseUrl("http://203.0.113.9:47820")).toBe("other");
    expect(classifyBaseUrl("https://core.example.com")).toBe("other");
    expect(classifyBaseUrl("garbage")).toBe("other");
  });
});

describe("relayHostLabel", () => {
  test("fabplane's own relays read as the site; anything else by host", () => {
    expect(relayHostLabel("https://relay.fabplane.com")).toBe("fabplane.com");
    expect(relayHostLabel("https://relay-staging.fabplane.com/")).toBe("fabplane.com");
    expect(relayHostLabel("https://fabplane.com/relay")).toBe("fabplane.com");
    expect(relayHostLabel("http://fabplane-staging.tail4f6a7.ts.net:4041")).toBe(
      "fabplane-staging.tail4f6a7.ts.net",
    );
    expect(relayHostLabel("http://127.0.0.1:4040")).toBe("127.0.0.1");
  });
});

describe("connectionPath and its labels", () => {
  test("null before a transport exists", () => {
    expect(connectionPath({ via: null, baseUrl: null })).toBeNull();
    expect(connectionPath({ via: "direct", baseUrl: null })).toBeNull();
  });

  test("a direct transport is labelled by the kind of its address", () => {
    const tailnet = connectionPath({ via: "direct", baseUrl: "http://100.64.0.1:47820" });
    expect(tailnet).toEqual({
      via: "direct",
      kind: "tailscale",
      baseUrl: "http://100.64.0.1:47820",
    });
    expect(pathLabel(tailnet!)).toBe("Direct · Tailscale");
    expect(
      pathLabel(connectionPath({ via: "direct", baseUrl: "http://192.168.1.24:47820" })!),
    ).toBe("Direct · LAN");
    expect(pathLabel(connectionPath({ via: "direct", baseUrl: "https://mac.tail.ts.net" })!)).toBe(
      "Direct · Tailscale HTTPS",
    );
    expect(pathHint(tailnet!)).toMatch(/Nothing goes through fabplane.com/);
  });

  test("a proxy transport is the relay, named from the saved relay URL (or its own prefix)", () => {
    const viaRelay = connectionPath({
      via: "relay",
      baseUrl: "https://relay.fabplane.com/c/core_abc",
      relayUrl: "https://relay.fabplane.com",
    });
    expect(viaRelay).toEqual({
      via: "relay",
      host: "fabplane.com",
      baseUrl: "https://relay.fabplane.com/c/core_abc",
    });
    expect(pathLabel(viaRelay!)).toBe("Via fabplane.com relay");
    expect(pathHint(viaRelay!)).toMatch(/from anywhere/);
    expect(
      pathLabel(connectionPath({ via: "relay", baseUrl: "http://127.0.0.1:4040/c/core_abc" })!),
    ).toBe("Via 127.0.0.1 relay");
  });
});

describe("streamBannerLabel", () => {
  test("nothing while open; the generic line otherwise", () => {
    expect(streamBannerLabel({ status: "open", coreOffline: false, name: "Mac" })).toBeNull();
    expect(streamBannerLabel({ status: "reconnecting", coreOffline: false, name: "Mac" })).toBe(
      "Reconnecting… · Mac",
    );
    expect(streamBannerLabel({ status: "connecting", coreOffline: false, name: undefined })).toBe(
      "Connecting… · your computer",
    );
  });

  test("the relay's 'core offline' verdict replaces the generic line", () => {
    expect(streamBannerLabel({ status: "reconnecting", coreOffline: true, name: "Mac" })).toBe(
      "Mac is offline — the relay is up, but it is not connected. Wake it to continue.",
    );
    // Once the stream is open again the verdict is stale, whatever the flag says.
    expect(streamBannerLabel({ status: "open", coreOffline: true, name: "Mac" })).toBeNull();
  });
});
