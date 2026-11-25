import { describe, expect, test } from "bun:test";
import type { ReleaseAsset, UpdateCheckResult } from "@fabdesk/protocol";
import { inPlaceAsset, inPlaceUnsupportedReason, toUpdateInfo } from "./update-feed";

function asset(platform: ReleaseAsset["platform"], arch: ReleaseAsset["arch"], kind: ReleaseAsset["kind"], ext: string): ReleaseAsset {
  const filename = `fabplane-0.4.20-${platform}-${arch}.${ext}`;
  return { filename, platform, arch, kind, url: `https://downloads.fabplane.com/desktop/v0.4.20/${filename}`, sha256: "a".repeat(64), size: 1234 };
}

const assets = [
  asset("darwin", "arm64", "dmg", "dmg"),
  asset("darwin", "arm64", "zip", "zip"),
  asset("darwin", "x64", "dmg", "dmg"),
  asset("darwin", "x64", "zip", "zip"),
  asset("win32", "x64", "exe", "exe"),
  asset("linux", "x64", "AppImage", "AppImage"),
  asset("linux", "x64", "deb", "deb"),
];

describe("inPlaceAsset", () => {
  test("macOS updates from the zip, never the DMG", () => {
    expect(inPlaceAsset(assets, "darwin", "arm64")?.filename).toBe("fabplane-0.4.20-darwin-arm64.zip");
    expect(inPlaceAsset(assets, "darwin", "x64")?.filename).toBe("fabplane-0.4.20-darwin-x64.zip");
  });

  test("Windows takes the installer and Linux the AppImage", () => {
    expect(inPlaceAsset(assets, "win32", "x64")?.kind).toBe("exe");
    expect(inPlaceAsset(assets, "linux", "x64")?.kind).toBe("AppImage");
  });

  test("an arm64 host without a native build takes x64; x64 never takes arm64", () => {
    expect(inPlaceAsset(assets, "win32", "arm64")?.arch).toBe("x64");
    expect(inPlaceAsset(assets.filter((a) => a.arch === "arm64"), "darwin", "x64")).toBeNull();
  });

  test("a release with only a DMG has nothing to apply in place", () => {
    expect(inPlaceAsset(assets.filter((a) => a.kind !== "zip"), "darwin", "arm64")).toBeNull();
    expect(inPlaceAsset(assets, "freebsd", "x64")).toBeNull();
  });
});

describe("inPlaceUnsupportedReason", () => {
  const mac = { platform: "darwin", packaged: true, exePath: "/Applications/fabPlane.app/Contents/MacOS/fabPlane" };

  test("an installed, packaged app updates in place", () => {
    expect(inPlaceUnsupportedReason(mac)).toBeNull();
    expect(inPlaceUnsupportedReason({ platform: "win32", packaged: true, exePath: "C:\\Program Files\\fabPlane\\fabplane.exe" })).toBeNull();
    expect(inPlaceUnsupportedReason({ platform: "linux", packaged: true, exePath: "/tmp/.mount_x/fabplane", appImage: "/home/u/fabplane.AppImage" })).toBeNull();
  });

  test("read-only macOS locations, .deb installs, dev builds and the opt-out do not", () => {
    expect(inPlaceUnsupportedReason({ ...mac, exePath: "/Volumes/fabPlane 0.4.19/fabPlane.app/Contents/MacOS/fabPlane" })).toContain("Applications");
    expect(inPlaceUnsupportedReason({ ...mac, exePath: "/private/var/folders/x/AppTranslocation/ABC/d/fabPlane.app/Contents/MacOS/fabPlane" })).toContain("Applications");
    expect(inPlaceUnsupportedReason({ platform: "linux", packaged: true, exePath: "/opt/fabPlane/fabplane" })).not.toBeNull();
    expect(inPlaceUnsupportedReason({ ...mac, packaged: false })).not.toBeNull();
    expect(inPlaceUnsupportedReason({ ...mac, disabled: true })).not.toBeNull();
  });
});

describe("toUpdateInfo", () => {
  test("carries the manifest's version, URL and SHA-256 to the updater", () => {
    const zip = inPlaceAsset(assets, "darwin", "arm64");
    if (!zip) throw new Error("no zip");
    const result: UpdateCheckResult = {
      checkedAt: "2026-11-25T00:00:00.000Z",
      currentVersion: "0.4.19",
      latest: {
        schema: 1,
        version: "0.4.20",
        tag: "v0.4.20",
        channel: "public",
        commit: "abc",
        publishedAt: "2026-11-25T09:00:00.000Z",
        releaseUrl: "https://github.com/fabPlane/fabdesk/releases/tag/v0.4.20",
        assets,
      },
      updateAvailable: true,
      asset: zip,
      downloadPageUrl: "https://fabplane.com/download",
    };
    expect(toUpdateInfo(result, zip)).toEqual({
      version: "0.4.20",
      releaseDate: "2026-11-25T09:00:00.000Z",
      path: zip.url,
      files: [{ url: zip.url, sha2: zip.sha256, size: 1234 }],
    });
    expect(toUpdateInfo({ ...result, latest: null }, zip)).toBeNull();
  });
});
