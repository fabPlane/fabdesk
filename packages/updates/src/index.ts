/**
 * Update checker shared by the Electron main process and `fabdesk-core doctor`.
 * Fetches the website's `desktop/latest.json`, compares semver, and picks the installer for the
 * running platform. Never downloads or installs anything itself.
 */
import {
  LatestRelease,
  type ReleaseArch,
  type ReleaseAsset,
  type ReleaseKind,
  type ReleaseManifest,
  type ReleasePlatform,
  type UpdateCheckResult,
} from "@fabdesk/protocol";
import type { z } from "zod/v4";

export const DEFAULT_UPDATE_URL = "https://fabplane.com/desktop/latest.json";
export const DEFAULT_DOWNLOAD_PAGE = "https://fabplane.com/download";
export const DEFAULT_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type Platform = z.infer<typeof ReleasePlatform>;
type Arch = z.infer<typeof ReleaseArch>;
type Kind = z.infer<typeof ReleaseKind>;

export function parseVersion(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Returns >0 if a is newer than b, <0 if older, 0 if equal or unparsable. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const PREFERRED_KINDS: Record<Platform, Kind[]> = {
  darwin: ["dmg", "zip"],
  win32: ["exe", "portable"],
  linux: ["AppImage", "deb"],
};

/** Picks the best installer for a platform/arch; falls back to x64 on arm64 hosts without a native build. */
export function pickAsset(
  assets: ReleaseAsset[],
  platform: Platform,
  arch: Arch,
  preferKind?: Kind,
): ReleaseAsset | null {
  const kinds = preferKind ? [preferKind, ...PREFERRED_KINDS[platform]] : PREFERRED_KINDS[platform];
  for (const candidateArch of arch === "arm64" ? (["arm64", "x64"] as const) : (["x64"] as const)) {
    for (const kind of kinds) {
      const hit = assets.find((a) => a.platform === platform && a.arch === candidateArch && a.kind === kind);
      if (hit) return hit;
    }
  }
  return null;
}

export function hostPlatform(p: string = process.platform): Platform | null {
  return p === "darwin" || p === "linux" || p === "win32" ? p : null;
}

export function hostArch(a: string = process.arch): Arch {
  return a === "arm64" ? "arm64" : "x64";
}

export interface CheckOptions {
  currentVersion: string;
  url?: string;
  downloadPageUrl?: string;
  platform?: Platform | null;
  arch?: Arch;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function checkForUpdate(opts: CheckOptions): Promise<UpdateCheckResult> {
  const url = opts.url ?? DEFAULT_UPDATE_URL;
  const downloadPageUrl = opts.downloadPageUrl ?? DEFAULT_DOWNLOAD_PAGE;
  const platform = opts.platform === undefined ? hostPlatform() : opts.platform;
  const arch = opts.arch ?? hostArch();
  const base = { checkedAt: new Date().toISOString(), currentVersion: opts.currentVersion, downloadPageUrl };
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = LatestRelease.safeParse(await response.json());
    if (!parsed.success) throw new Error("latest.json failed validation");
    if (parsed.data.version === null) {
      return { ...base, latest: null, updateAvailable: false, asset: null };
    }
    const latest: ReleaseManifest = parsed.data;
    const updateAvailable = compareVersions(latest.version, opts.currentVersion) > 0;
    const asset = platform ? pickAsset(latest.assets, platform, arch) : null;
    return { ...base, latest, updateAvailable, asset };
  } catch (error) {
    return {
      ...base,
      latest: null,
      updateAvailable: false,
      asset: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
