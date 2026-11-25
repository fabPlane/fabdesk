/**
 * Maps the website's `desktop/latest.json` (the feed the update badge already reads) onto what
 * electron-updater needs to replace the running app, so in-place updates need no second feed.
 * No Electron imports: this file is unit-tested under Bun.
 */
import type { ReleaseAsset, UpdateCheckResult } from "@fabdesk/protocol";

type Platform = ReleaseAsset["platform"];
type Arch = ReleaseAsset["arch"];

/** The package the updater can apply without the user: Squirrel.Mac takes a zip, not the DMG. */
const IN_PLACE_KIND: Record<Platform, ReleaseAsset["kind"]> = {
  darwin: "zip",
  win32: "exe",
  linux: "AppImage",
};

export interface InPlaceEnvironment {
  platform: string;
  packaged: boolean;
  /** Path of the running executable. */
  exePath: string;
  /** `APPIMAGE`, set by the AppImage runtime. */
  appImage?: string | undefined;
  /** `FABDESK_UPDATE_INPLACE=0` keeps the old download-and-open flow. */
  disabled?: boolean | undefined;
}

/** Why this install cannot replace itself, or null when it can. */
export function inPlaceUnsupportedReason(env: InPlaceEnvironment): string | null {
  if (env.disabled) return "In-place updates are turned off.";
  if (!env.packaged) return "Development builds do not update themselves.";
  if (env.platform === "darwin") {
    // Opened straight from the mounted DMG, or quarantined and translocated: both are read-only.
    if (env.exePath.startsWith("/Volumes/") || env.exePath.includes("/AppTranslocation/")) {
      return "Move fabPlane to the Applications folder to update it in place.";
    }
    return null;
  }
  if (env.platform === "win32") return null;
  if (env.platform === "linux") {
    // A .deb install is owned by the package manager.
    return env.appImage ? null : "Only the AppImage updates itself.";
  }
  return "This platform does not update in place.";
}

/** The asset the updater applies on this platform, or null when the release has none. */
export function inPlaceAsset(assets: ReleaseAsset[], platform: string, arch: string): ReleaseAsset | null {
  if (platform !== "darwin" && platform !== "win32" && platform !== "linux") return null;
  const kind = IN_PLACE_KIND[platform];
  const arches: Arch[] = arch === "arm64" ? ["arm64", "x64"] : ["x64"];
  for (const candidate of arches) {
    const hit = assets.find((a) => a.platform === platform && a.kind === kind && a.arch === candidate);
    if (hit) return hit;
  }
  return null;
}

/** electron-updater's `UpdateInfo`, with the manifest's SHA-256 as the checksum it verifies. */
export interface FeedUpdateInfo {
  version: string;
  releaseDate: string;
  path: string;
  files: Array<{ url: string; sha2: string; size: number }>;
}

export function toUpdateInfo(result: UpdateCheckResult, asset: ReleaseAsset): FeedUpdateInfo | null {
  if (!result.latest) return null;
  return {
    version: result.latest.version,
    releaseDate: result.latest.publishedAt,
    path: asset.url,
    files: [{ url: asset.url, sha2: asset.sha256, size: asset.size }],
  };
}
