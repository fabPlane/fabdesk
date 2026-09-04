import { describe, expect, test } from "bun:test";
import {
  catalogHostedUrl,
  catalogInitials,
  catalogPhotoUrl,
  catalogPreviewUrl,
  catalogPublicOrigin,
  CoreEvent,
  DaemonHandshake,
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
