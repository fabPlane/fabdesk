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
  /** electron-builder writes resources/package-type into its Debian package. */
  packageType?: string | undefined;
  volumeWritable?: boolean | undefined;
}

export type AlternateInstallMode = "move-to-applications" | "system-package" | "installer";

/** Null means the native updater can stage this build for the next launch. */
export function alternateInstallMode(env: InPlaceEnvironment): AlternateInstallMode | null {
  if (!env.packaged || env.disabled) return "installer";
  if (env.platform === "darwin") {
    const readOnly = env.exePath.includes("/AppTranslocation/") || (env.exePath.startsWith("/Volumes/") && !env.volumeWritable);
    return readOnly ? "move-to-applications" : null;
  }
  if (env.platform === "win32" || (env.platform === "linux" && env.appImage)) return null;
  return env.platform === "linux" && env.packageType === "deb" ? "system-package" : "installer";
}

/** A package-managed installation must stay on the same package format and architecture. */
export function assetForInstallMode(result: UpdateCheckResult, mode: AlternateInstallMode | null, platform: string, arch: string, appImage?: string): ReleaseAsset | null {
  if (mode === "system-package" || (mode === "installer" && platform === "linux" && !appImage)) {
    return result.latest?.assets.find(a => a.platform === "linux" && a.arch === arch && a.kind === "deb") ?? null;
  }
  if (mode === "move-to-applications" || mode === null) {
    return inPlaceAsset(result.latest?.assets ?? [], platform, arch);
  }
  return result.asset;
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
