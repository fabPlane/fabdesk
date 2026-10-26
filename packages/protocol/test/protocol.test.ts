import { describe, expect, test } from "bun:test";
import {
  buildPairingUrl,
  candidateBaseUrls,
  catalogHostedUrl,
  catalogInitials,
  catalogPhotoUrl,
  catalogPreviewUrl,
  catalogPublicOrigin,
  CoreEndpoint,
  CoreEvent,
  DaemonHandshake,
  endpointBaseUrl,
  endpointScheme,
  orderEndpoints,
  RemoteStatus,
  pairingUrlFromEndpoints,
  parsePairingUrl,
  Settings,
  CloudSettings,
  findOpenCatalogArg,
  isOpenCatalogIntent,
  isCatalogWebsiteAsset,
  isGitHubAssetHost,
  openCatalogHref,
  parseOpenCatalogHref,
  DEFAULT_CATALOG_PUBLIC_ORIGIN,
  LatestRelease,
  NetlistFile,
  ReleaseManifest,
  RouteFrameLine,
  topicMatches,
  FIRST_INSTALL_PRIVACY_SCREEN,
  usageArchiveAllowed,
  usageArchiveChoice,
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
    const frame = {
      kind: "frame",
      runId: "r1",
      seq: 3,
      event: { kind: "attempt", netNumber: 2 },
      elapsedMs: 12,
      shapes: [{ k: "trace", id: 1, layer: 0, net: 2, pts: [0, 0, 1, 1], w: 0.2 }],
    };
    expect(RouteFrameLine.parse(frame).kind).toBe("frame");
    expect(CoreEvent.safeParse({ ts: 1, topic: "route.frame", frame }).success).toBe(true);
  });
  test("LatestRelease accepts the no-release placeholder and a manifest", () => {
    expect(LatestRelease.parse({ schema: 1, version: null, assets: [] }).version).toBeNull();
    const manifest = ReleaseManifest.parse({
      schema: 1,
      version: "0.1.9",
      tag: "v0.1.9",
      channel: "public",
      commit: "abc",
      publishedAt: "2026-09-02T00:00:00Z",
      releaseUrl: "https://github.com/TensorFleet/fabdesk/releases/tag/v0.1.9",
      assets: [
        {
          filename: "Fabdesk-0.1.9-mac-arm64.dmg",
          platform: "darwin",
          arch: "arm64",
          kind: "dmg",
          url: "https://x/y.dmg",
          sha256: "a".repeat(64),
          size: 1,
        },
      ],
    });
    expect(manifest.assets[0]?.platform).toBe("darwin");
    expect(ReleaseManifest.safeParse({ ...manifest, version: "1.2" }).success).toBe(false);
  });
  test("catalog hosted asset URLs stay on the images CDN, not GitHub or the website", () => {
    expect(catalogPublicOrigin()).toBe(DEFAULT_CATALOG_PUBLIC_ORIGIN);
    expect(catalogPreviewUrl("im-tomu", "fomu-hardware")).toBe(
      "https://images.fabplane.com/artifacts/open-catalog/im-tomu/fomu-hardware/preview.webp",
    );
    expect(catalogPhotoUrl("tensorfleet", "koyomi-lvds-hat")).toBe(
      "https://images.fabplane.com/artifacts/open-catalog/tensorfleet/koyomi-lvds-hat/photo.webp",
    );
    expect(catalogHostedUrl("foostan", "crkbd", "preview.webp")).toContain(
      "/artifacts/open-catalog/foostan/crkbd/preview.webp",
    );
    expect(
      isGitHubAssetHost("https://raw.githubusercontent.com/im-tomu/fomu-hardware/master/fomu.png"),
    ).toBe(true);
    expect(isGitHubAssetHost(catalogPreviewUrl("im-tomu", "fomu-hardware"))).toBe(false);
    expect(isCatalogWebsiteAsset(catalogPreviewUrl("im-tomu", "fomu-hardware"))).toBe(false);
    expect(
      isCatalogWebsiteAsset("https://fabplane.com/open-catalog/im-tomu/fomu-hardware/preview.webp"),
    ).toBe(true);
  });

  test("catalogInitials uses the first two words, else the first two letters", () => {
    expect(catalogInitials("HackRF One")).toBe("HO");
    expect(catalogInitials("Koyomi LVDS HAT")).toBe("KL");
    expect(catalogInitials("iCEBreaker FPGA")).toBe("IF");
    expect(catalogInitials("crkbd")).toBe("CR");
    expect(catalogInitials("   ")).toBe("?");
  });

  test("CloudSettings is last-write-wins portable prefs, unknown keys stripped", () => {
    const parsed = CloudSettings.parse({
      schema: 1,
      updatedAt: 42,
      appearance: "dark",
      extra: true,
    });
    expect(parsed).toEqual({ schema: 1, updatedAt: 42, appearance: "dark" });
    expect(CloudSettings.safeParse({ schema: 1 }).success).toBe(false);
    expect(CloudSettings.safeParse({ schema: 2, updatedAt: 1 }).success).toBe(false);
  });

  test("DaemonHandshake requires a real token", () => {
    const ok = {
      version: "0.1.0",
      pid: 1,
      port: 2,
      token: "x".repeat(32),
      startedAt: "now",
      channel: "public",
      authMode: "local",
      runtimeId: "runtime-123456789",
    };
    expect(DaemonHandshake.parse(ok).host).toBe("127.0.0.1");
    expect(DaemonHandshake.safeParse({ ...ok, token: "short" }).success).toBe(false);
    expect(DaemonHandshake.safeParse({ ...ok, runtimeId: "short" }).success).toBe(false);
  });

  test("NetlistFile accepts explicit component placements", () => {
    const parsed = NetlistFile.parse({
      netlist: { components: [], nets: [] },
      board: { placements: [{ ref: "R1", position: { x: 12.5, y: 7 } }] },
    });
    expect(parsed.board?.placements?.[0]).toEqual({ ref: "R1", position: { x: 12.5, y: 7 } });
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
    expect(
      buildPairingUrl({
        version: 1,
        token: "tok",
        hosts: ["100.64.0.1", "192.168.1.24"],
        port: 47820,
        name: "Mac",
      }),
    ).toBe(legacy);
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
    expect(candidateBaseUrls(parsePairingUrl(url)!)).toEqual([
      "http://100.64.0.1:47820",
      "http://192.168.1.24:47820",
    ]);
  });

  test("a k= list that does not line up with h= is dropped, and unknown kinds become other", () => {
    expect(parsePairingUrl(`${legacy}&k=tailscale`)?.kinds).toBeUndefined();
    expect(parsePairingUrl(`${legacy}&k=tailscale&k=https`)?.kinds).toEqual(["tailscale", "other"]);
    // A mismatched list is never emitted either.
    expect(
      buildPairingUrl({
        version: 1,
        token: "t",
        hosts: ["a", "b"],
        kinds: ["lan"],
        port: 1,
        name: "n",
      }),
    ).not.toContain("k=");
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
    const url = pairingUrlFromEndpoints({
      token: "t",
      endpoints: [...endpoints].reverse(),
      port: 1,
      name: "n",
    });
    expect(parsePairingUrl(url)?.hosts[0]).toBe("192.168.1.24");
    expect(parsePairingUrl(url)?.kinds?.[0]).toBe("lan");
    // Preferring loopback is refused: it never works from a phone.
    expect(orderEndpoints(endpoints, "loopback")[0]?.kind).toBe("tailscale");
  });

  test("Settings.remote.preferredEndpointKind defaults to unset and rejects made-up kinds", () => {
    expect(Settings.parse({}).remote.preferredEndpointKind).toBeUndefined();
    expect(Settings.parse({}).tracemakerManifestUrl).toBeNull();
    expect(
      Settings.parse({ remote: { preferredEndpointKind: null } }).remote.preferredEndpointKind,
    ).toBeNull();
    expect(Settings.parse({ remote: { preferredEndpointKind: "lan" } }).remote).toMatchObject({
      preferredEndpointKind: "lan",
      enabled: false,
    });
    expect(Settings.safeParse({ remote: { preferredEndpointKind: "wifi" } }).success).toBe(false);
  });

  test("Settings.voice defaults and rejects an unknown provider", () => {
    expect(Settings.parse({}).voice).toEqual({
      provider: "auto",
      language: "en",
      pushToTalkMode: "hold",
      pushToTalkShortcut: "Alt+Space",
    });
    expect(Settings.parse({ voice: { language: "de", provider: "cloud" } }).voice).toMatchObject({
      provider: "cloud",
      language: "de",
      pushToTalkMode: "hold",
    });
    expect(Settings.safeParse({ voice: { provider: "whisper" } }).success).toBe(false);
  });

  test("an https endpoint adds a parallel s= list and is tried first, on 443 without a port", () => {
    const endpoints = orderEndpoints(
      [
        { host: "192.168.1.24", port: 47820, kind: "lan", iface: "en0" },
        {
          host: "100.64.0.1",
          port: 47820,
          kind: "tailscale",
          iface: "utun4",
          hostname: "mac.tail.ts.net",
        },
        {
          host: "mac.tail.ts.net",
          port: 443,
          kind: "tailscale-https",
          iface: "utun4",
          scheme: "https",
          hostname: "mac.tail.ts.net",
        },
      ],
      null,
    );
    expect(endpoints.map((e) => e.kind)).toEqual(["tailscale-https", "tailscale", "lan"]);
    const url = pairingUrlFromEndpoints({ token: "t", endpoints, port: 47820, name: "Mac" });
    expect(url).toBe(
      "fabdesk://pair?v=1&t=t&p=47820&n=Mac&h=mac.tail.ts.net&h=100.64.0.1&h=192.168.1.24&k=tailscale-https&k=tailscale&k=lan&s=https&s=http&s=http",
    );
    const parsed = parsePairingUrl(url)!;
    expect(parsed.schemes).toEqual(["https", "http", "http"]);
    expect(candidateBaseUrls(parsed)).toEqual([
      "https://mac.tail.ts.net",
      "http://100.64.0.1:47820",
      "http://192.168.1.24:47820",
    ]);
    // A LAN preference moves the LAN host first in the URL; the phone still tries https first.
    const lanFirst = parsePairingUrl(
      pairingUrlFromEndpoints({
        token: "t",
        endpoints: orderEndpoints(endpoints, "lan"),
        port: 47820,
        name: "Mac",
      }),
    )!;
    expect(lanFirst.hosts[0]).toBe("192.168.1.24");
    expect(candidateBaseUrls(lanFirst)[0]).toBe("https://mac.tail.ts.net");
    expect(endpointBaseUrl({ host: "mac.tail.ts.net", port: 8443, scheme: "https" })).toBe(
      "https://mac.tail.ts.net:8443",
    );
    expect(endpointBaseUrl({ host: "fd7a::1", port: 47820 })).toBe("http://[fd7a::1]:47820");
  });

  test("s= is omitted while every endpoint is http, and an old phone reads the MagicDNS host as plain http", () => {
    const allHttp = pairingUrlFromEndpoints({
      token: "t",
      endpoints: orderEndpoints(
        [
          {
            host: "100.64.0.1",
            port: 47820,
            kind: "tailscale",
            iface: "utun4",
            hostname: "mac.tail.ts.net",
          },
        ],
        null,
      ),
      port: 47820,
      name: "Mac",
    });
    expect(allHttp).not.toContain("s=");
    expect(parsePairingUrl(allHttp)?.schemes).toBeUndefined();
    const mixed =
      "fabdesk://pair?v=1&t=t&p=47820&n=Mac&h=mac.tail.ts.net&h=100.64.0.1&k=tailscale-https&k=tailscale&s=https&s=http";
    const legacyView = parsePairingUrl(mixed.replace(/&[ks]=[a-z-]+/g, ""))!;
    expect(legacyView.schemes).toBeUndefined();
    expect(candidateBaseUrls(legacyView)).toEqual([
      "http://mac.tail.ts.net:47820",
      "http://100.64.0.1:47820",
    ]);
    // A mismatched or unknown scheme list falls back to http rather than guessing.
    expect(parsePairingUrl(`${mixed}&s=https`)?.schemes).toBeUndefined();
    expect(parsePairingUrl(mixed.replace("s=https", "s=wss"))?.schemes).toEqual(["http", "http"]);
    expect(candidateBaseUrls({ hosts: ["a", "b"], port: 1, schemes: ["https"] })).toEqual([
      "http://a:1",
      "http://b:1",
    ]);
  });

  test("RemoteStatus and CoreEndpoint accept the Tailscale additions and their absence", () => {
    const plain = { host: "1.2.3.4", port: 1, kind: "lan", iface: "en0", default: true };
    expect(CoreEndpoint.parse(plain).scheme).toBeUndefined();
    expect(endpointScheme(CoreEndpoint.parse(plain))).toBe("http");
    expect(CoreEndpoint.safeParse({ ...plain, scheme: "ftp" }).success).toBe(false);
    const status = { enabled: false, setting: Settings.parse({}).remote, endpoints: [plain] };
    expect(RemoteStatus.parse(status).tailscale).toBeUndefined();
    expect(RemoteStatus.parse({ ...status, tailscale: null }).tailscale).toBeNull();
    expect(
      RemoteStatus.parse({
        ...status,
        tailscale: {
          ip: "100.64.0.1",
          dnsName: "mac.tail.ts.net",
          httpsEnabled: true,
          serve: { port: 443 },
        },
      }).tailscale?.serve?.port,
    ).toBe(443);
  });
});

describe("open-catalog deep links", () => {
  test("parses protocol and website URLs", () => {
    expect(openCatalogHref("foostan/crkbd")).toBe("fabplane://open?catalog=foostan%2Fcrkbd");
    expect(parseOpenCatalogHref("fabplane://open?catalog=tensorfleet/koyomi-lvds-hat")).toEqual({
      catalogId: "tensorfleet/koyomi-lvds-hat",
      remix: false,
    });
    expect(parseOpenCatalogHref("fabplane://open/foostan/crkbd?remix=1")).toEqual({
      catalogId: "foostan/crkbd",
      remix: true,
    });
    expect(parseOpenCatalogHref("https://fabplane.com/open/im-tomu/fomu-hardware/")).toEqual({
      catalogId: "im-tomu/fomu-hardware",
      remix: false,
    });
    expect(findOpenCatalogArg(["--hidden", "fabplane://open?catalog=foostan/crkbd"])).toEqual({
      catalogId: "foostan/crkbd",
      remix: false,
    });
    expect(parseOpenCatalogHref("https://fabplane.com/explore")).toBeNull();
    expect(isOpenCatalogIntent({ catalogId: "foostan/crkbd", remix: true })).toBe(true);
    expect(isOpenCatalogIntent({ catalogId: "foostan/crkbd" })).toBe(false);
  });
});

describe("usage archive consent", () => {
  test("the first-install privacy screen defaults to regional detection", () => {
    expect(FIRST_INSTALL_PRIVACY_SCREEN).toBe("auto");
  });

  test("defaults on for undecided installations that skip the screen", () => {
    const fresh = Settings.parse({});
    expect(fresh.usageArchiveChoiceComplete).toBe(false);
    expect(usageArchiveAllowed(fresh, false)).toBe(true);
    // A stale unchecked value without a recorded choice is not an opt-out.
    expect(usageArchiveAllowed({ usageArchiveConsent: false, usageArchiveChoiceComplete: false }, false)).toBe(true);
  });

  test("an explicit choice always wins", () => {
    for (const screen of [true, false]) {
      expect(usageArchiveAllowed(usageArchiveChoice(false), screen)).toBe(false);
      expect(usageArchiveAllowed(usageArchiveChoice(true), screen)).toBe(true);
    }
  });

  test("with the screen, nothing is allowed until the person chooses", () => {
    expect(usageArchiveAllowed(Settings.parse({}), true)).toBe(false);
    expect(usageArchiveAllowed({ usageArchiveConsent: true, usageArchiveChoiceComplete: false }, true)).toBe(false);
  });
});
