/**
 * Desktop release manifest: produced by fabdesk's release workflow (scripts/release-manifest.ts),
 * republished by fabplane.com as `/desktop/latest.json`, consumed by the app's update checker.
 * Field names are a contract with the website; do not rename.
 */
import { z } from "zod/v4";

export const ReleasePlatform = z.enum(["darwin", "linux", "win32"]);
export const ReleaseArch = z.enum(["arm64", "x64"]);
export const ReleaseKind = z.enum(["dmg", "zip", "AppImage", "deb", "exe", "portable"]);

export const ReleaseAsset = z.object({
  filename: z.string(),
  platform: ReleasePlatform,
  arch: ReleaseArch,
  kind: ReleaseKind,
  url: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});
export type ReleaseAsset = z.infer<typeof ReleaseAsset>;

export const ReleaseManifest = z.object({
  schema: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  tag: z.string(),
  channel: z.literal("public"),
  commit: z.string(),
  publishedAt: z.string(),
  releaseUrl: z.string().url(),
  notes: z.string().optional(),
  assets: z.array(ReleaseAsset),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

/** `latest.json` on the website: a manifest, or the "no release yet" placeholder. */
export const LatestRelease = z.union([
  ReleaseManifest,
  z.object({ schema: z.literal(1), version: z.null(), assets: z.array(z.never()).optional() }),
]);
export type LatestRelease = z.infer<typeof LatestRelease>;

export const UpdateCheckResult = z.object({
  checkedAt: z.string(),
  currentVersion: z.string(),
  latest: ReleaseManifest.nullable(),
  updateAvailable: z.boolean(),
  asset: ReleaseAsset.nullable(),
  downloadPageUrl: z.string(),
  error: z.string().optional(),
});
export type UpdateCheckResult = z.infer<typeof UpdateCheckResult>;

/** Progress of an in-app installer download started from the update badge. */
export const UpdateDownloadState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("idle") }),
  z.object({
    state: z.literal("downloading"),
    version: z.string(),
    filename: z.string(),
    received: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    /** 0..1, or null when the total size is unknown. */
    percent: z.number().min(0).max(1).nullable(),
    bytesPerSecond: z.number().nonnegative().nullable(),
  }),
  z.object({ state: z.literal("verifying"), version: z.string(), filename: z.string() }),
  z.object({ state: z.literal("done"), version: z.string(), filename: z.string(), path: z.string(), sha256: z.string() }),
  z.object({ state: z.literal("error"), version: z.string().optional(), message: z.string() }),
]);
export type UpdateDownloadState = z.infer<typeof UpdateDownloadState>;
