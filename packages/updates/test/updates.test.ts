import { describe, expect, test } from "bun:test";
import { checkForUpdate, compareVersions, parseVersion, pickAsset } from "../src/index";
import type { ReleaseAsset, ReleaseManifest } from "@fabdesk/protocol";

const asset = (platform: ReleaseAsset["platform"], arch: ReleaseAsset["arch"], kind: ReleaseAsset["kind"]): ReleaseAsset => ({
  filename: `Fabdesk-0.1.5-${platform}-${arch}.${kind}`,
  platform,
  arch,
  kind,
  url: `https://downloads.example/${platform}-${arch}.${kind}`,
  sha256: "a".repeat(64),
  size: 10,
});

const manifest: ReleaseManifest = {
  schema: 1,
  version: "0.1.5",
  tag: "v0.1.5",
  channel: "public",
  commit: "abc",
  publishedAt: "2026-09-02T00:00:00Z",
  releaseUrl: "https://github.com/TensorFleet/fabdesk/releases/tag/v0.1.5",
  assets: [asset("darwin", "arm64", "dmg"), asset("darwin", "x64", "dmg"), asset("win32", "x64", "exe"), asset("linux", "x64", "AppImage"), asset("linux", "x64", "deb")],
};

const fakeFetch = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("versions", () => {
  test("parse and compare", () => {
    expect(parseVersion("v0.1.42")).toEqual([0, 1, 42]);
    expect(compareVersions("0.1.10", "0.1.9")).toBeGreaterThan(0);
    expect(compareVersions("0.2.0", "0.1.99")).toBeGreaterThan(0);
    expect(compareVersions("0.1.5", "0.1.5")).toBe(0);
    expect(compareVersions("garbage", "0.1.5")).toBe(0);
  });
});

describe("pickAsset", () => {
  test("prefers native arch and platform kind order", () => {
    expect(pickAsset(manifest.assets, "darwin", "arm64")?.arch).toBe("arm64");
    expect(pickAsset(manifest.assets, "linux", "x64")?.kind).toBe("AppImage");
    expect(pickAsset(manifest.assets, "linux", "x64", "deb")?.kind).toBe("deb");
    expect(pickAsset(manifest.assets, "win32", "arm64")?.arch).toBe("x64");
    expect(pickAsset([], "darwin", "arm64")).toBeNull();
  });
});

describe("checkForUpdate", () => {
  test("reports an update when the website is newer", async () => {
    const result = await checkForUpdate({ currentVersion: "0.1.4", platform: "darwin", arch: "arm64", fetchImpl: fakeFetch(manifest) });
    expect(result.updateAvailable).toBe(true);
    expect(result.asset?.filename).toContain("darwin-arm64");
    expect(result.error).toBeUndefined();
  });
  test("no update when current is equal or newer", async () => {
    const same = await checkForUpdate({ currentVersion: "0.1.5", platform: "linux", fetchImpl: fakeFetch(manifest) });
    expect(same.updateAvailable).toBe(false);
    expect(same.latest?.version).toBe("0.1.5");
  });
  test("handles the no-release placeholder", async () => {
    const result = await checkForUpdate({ currentVersion: "0.1.0", platform: "win32", fetchImpl: fakeFetch({ schema: 1, version: null, assets: [] }) });
    expect(result.latest).toBeNull();
    expect(result.updateAvailable).toBe(false);
    expect(result.error).toBeUndefined();
  });
  test("network and validation failures are reported, never thrown", async () => {
    const bad = await checkForUpdate({ currentVersion: "0.1.0", platform: "darwin", fetchImpl: fakeFetch({ nope: true }) });
    expect(bad.error).toBe("latest.json failed validation");
    const down = await checkForUpdate({ currentVersion: "0.1.0", platform: "darwin", fetchImpl: fakeFetch({}, 503) });
    expect(down.error).toBe("HTTP 503");
  });
});
