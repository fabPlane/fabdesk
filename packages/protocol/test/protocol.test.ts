import { describe, expect, test } from "bun:test";
import {
  buildPairingUrl,
  candidateBaseUrls,
  catalogHostedUrl,
  catalogInitials,
  catalogPhotoUrl,
  catalogPreviewUrl,
  catalogPublicOrigin,
  CoreEvent,
  DaemonHandshake,
  orderEndpoints,
  pairingUrlFromEndpoints,
  parsePairingUrl,
  Settings,
  isCatalogWebsiteAsset,
  isGitHubAssetHost,
  DEFAULT_CATALOG_PUBLIC_ORIGIN,
  LatestRelease,
  ReleaseManifest,
  RouteFrameLine,
  topicMatches,
} from "../src/index";

describe("topicMatches", () => {
  test("exact, wildcard and prefix globs", () => {
    expect(topicMatches("agent.delta", "agent.delta")).toBe(true);
    expect(topicMatches("agent.*", "agent.tool_use")).toBe(true);
    expect(topicMatches("*", "route.frame")).toBe(true);
    expect(topicMatches("agent.*", "job.done")).toBe(false);
    expect(topicMatches("agent", "agent.delta")).toBe(false);
  });
});

describe("schemas", () => {
  test("CoreEvent rejects unknown topics and accepts route frames", () => {
    expect(CoreEvent.safeParse({ ts: 1, topic: "nope" }).success).toBe(false);
    const frame = { kind: "frame", runId: "r1", seq: 3, event: { kind: "attempt", netNumber: 2 }, elapsedMs: 12, shapes: [{ k: "trace", id: 1, layer: 0, net: 2, pts: [0, 0, 1, 1], w: 0.2 }] };
    expect(RouteFrameLine.parse(frame).kind).toBe("frame");
    expect(CoreEvent.safeParse({ ts: 1, topic: "route.frame", frame }).success).toBe(true);
  });
  test("LatestRelease accepts the no-release placeholder and a manifest", () => {
    expect(LatestRelease.parse({ schema: 1, version: null, assets: [] }).version).toBeNull();
    const manifest = ReleaseManifest.parse({
      schema: 1, version: "0.1.9", tag: "v0.1.9", channel: "public", commit: "abc", publishedAt: "2026-09-02T00:00:00Z",
      releaseUrl: "https://github.com/TensorFleet/fabdesk/releases/tag/v0.1.9",
      assets: [{ filename: "Fabdesk-0.1.9-mac-arm64.dmg", platform: "darwin", arch: "arm64", kind: "dmg", url: "https://x/y.dmg", sha256: "a".repeat(64), size: 1 }],
    });
    expect(manifest.assets[0]?.platform).toBe("darwin");
    expect(ReleaseManifest.safeParse({ ...manifest, version: "1.2" }).success).toBe(false);
  });
  test("catalog hosted asset URLs stay on the images CDN, not GitHub or the website", () => {
    expect(catalogPublicOrigin()).toBe(DEFAULT_CATALOG_PUBLIC_ORIGIN);
    expect(catalogPreviewUrl("im-tomu", "fomu-hardware")).toBe("https://images.fabplane.com/artifacts/open-catalog/im-tomu/fomu-hardware/preview.webp");
    expect(catalogPhotoUrl("tensorfleet", "koyomi-lvds-hat")).toBe("https://images.fabplane.com/artifacts/open-catalog/tensorfleet/koyomi-lvds-hat/photo.webp");
    expect(catalogHostedUrl("foostan", "crkbd", "preview.webp")).toContain("/artifacts/open-catalog/foostan/crkbd/preview.webp");
    expect(isGitHubAssetHost("https://raw.githubusercontent.com/im-tomu/fomu-hardware/master/fomu.png")).toBe(true);
    expect(isGitHubAssetHost(catalogPreviewUrl("im-tomu", "fomu-hardware"))).toBe(false);
    expect(isCatalogWebsiteAsset(catalogPreviewUrl("im-tomu", "fomu-hardware"))).toBe(false);
    expect(isCatalogWebsiteAsset("https://fabplane.com/open-catalog/im-tomu/fomu-hardware/preview.webp")).toBe(true);
  });

  test("catalogInitials uses the first two words, else the first two letters", () => {
    expect(catalogInitials("HackRF One")).toBe("HO");
    expect(catalogInitials("Koyomi LVDS HAT")).toBe("KL");
    expect(catalogInitials("iCEBreaker FPGA")).toBe("IF");
    expect(catalogInitials("crkbd")).toBe("CR");
    expect(catalogInitials("   ")).toBe("?");
  });

  test("DaemonHandshake requires a real token", () => {
    const ok = { version: "0.1.0", pid: 1, port: 2, token: "x".repeat(32), startedAt: "now", channel: "public", authMode: "local" };
    expect(DaemonHandshake.parse(ok).host).toBe("127.0.0.1");
    expect(DaemonHandshake.safeParse({ ...ok, token: "short" }).success).toBe(false);
  });
});

describe("pairing url", () => {
  const legacy = "fabdesk://pair?v=1&t=tok&p=47820&n=Mac&h=100.64.0.1&h=192.168.1.24";

  test("a link from before endpoint kinds still parses, without kinds", () => {
    expect(parsePairingUrl(legacy)).toEqual({
      version: 1,
      token: "tok",
      hosts: ["100.64.0.1", "192.168.1.24"],
      port: 47820,
      name: "Mac",
    });
    // …and building without kinds emits the exact legacy form, so old phones see nothing new.
    expect(buildPairingUrl({ version: 1, token: "tok", hosts: ["100.64.0.1", "192.168.1.24"], port: 47820, name: "Mac" })).toBe(legacy);
  });

  test("kinds ride along as a parallel k= list and round-trip", () => {
    const url = buildPairingUrl({
      version: 1,
      token: "tok",
      hosts: ["100.64.0.1", "192.168.1.24"],
      kinds: ["tailscale", "lan"],
      port: 47820,
      name: "Mac",
    });
    expect(url).toBe(`${legacy}&k=tailscale&k=lan`);
    expect(parsePairingUrl(url)?.kinds).toEqual(["tailscale", "lan"]);
    // An old phone's view of the same link: `k=` stripped. Hosts and order are untouched.
    expect(parsePairingUrl(url.replace(/&k=[a-z]+/g, ""))).toEqual(parsePairingUrl(legacy));
    expect(candidateBaseUrls(parsePairingUrl(url)!)).toEqual(["http://100.64.0.1:47820", "http://192.168.1.24:47820"]);
  });

  test("a k= list that does not line up with h= is dropped, and unknown kinds become other", () => {
    expect(parsePairingUrl(`${legacy}&k=tailscale`)?.kinds).toBeUndefined();
    expect(parsePairingUrl(`${legacy}&k=tailscale&k=https`)?.kinds).toEqual(["tailscale", "other"]);
    // A mismatched list is never emitted either.
    expect(buildPairingUrl({ version: 1, token: "t", hosts: ["a", "b"], kinds: ["lan"], port: 1, name: "n" })).not.toContain("k=");
  });

  test("the default endpoint leads the URL whatever order the list came in", () => {
    const endpoints = orderEndpoints(
      [
        { host: "127.0.0.1", port: 1, kind: "loopback", iface: "lo0" },
        { host: "192.168.1.24", port: 1, kind: "lan", iface: "en0" },
        { host: "100.64.0.1", port: 1, kind: "tailscale", iface: "ts0" },
      ],
      "lan",
    );
    expect(endpoints.map((e) => [e.host, e.default])).toEqual([
      ["192.168.1.24", true],
      ["100.64.0.1", false],
      ["127.0.0.1", false],
    ]);
    const url = pairingUrlFromEndpoints({ token: "t", endpoints: [...endpoints].reverse(), port: 1, name: "n" });
    expect(parsePairingUrl(url)?.hosts[0]).toBe("192.168.1.24");
    expect(parsePairingUrl(url)?.kinds?.[0]).toBe("lan");
    // Preferring loopback is refused: it never works from a phone.
    expect(orderEndpoints(endpoints, "loopback")[0]?.kind).toBe("tailscale");
  });

  test("Settings.remote.preferredEndpointKind defaults to unset and rejects made-up kinds", () => {
    expect(Settings.parse({}).remote.preferredEndpointKind).toBeUndefined();
    expect(Settings.parse({ remote: { preferredEndpointKind: null } }).remote.preferredEndpointKind).toBeNull();
    expect(Settings.parse({ remote: { preferredEndpointKind: "lan" } }).remote).toMatchObject({ preferredEndpointKind: "lan", enabled: false });
    expect(Settings.safeParse({ remote: { preferredEndpointKind: "wifi" } }).success).toBe(false);
  });
});
