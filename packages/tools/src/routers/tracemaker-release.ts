import { z } from "zod/v4";
import { SHA256_HEX, offlineOrFetchError } from "./checksum";
import type { RouterArtifact, RouterArtifactFormat } from "./catalog";

export const TRACEMAKER_UPSTREAM_REPO = "DingoOz/TraceMaker";
export const TRACEMAKER_BINARY_RELEASE_REPO = "TensorFleet/fabdesk";
export const TRACEMAKER_BINARY_RELEASE_TAG = "tracemaker-latest";

export const TRACEMAKER_PLATFORMS = [
  "linux-x86_64",
  "macos-arm64",
  "macos-x86_64",
  "windows-x86_64",
] as const;
export type TraceMakerPlatform = (typeof TRACEMAKER_PLATFORMS)[number];

const PlatformSchema = z.enum(TRACEMAKER_PLATFORMS);
const FormatSchema = z.enum(["jar", "zip", "tar.gz", "file"]);

export const TraceMakerAssetSchema = z.object({
  platform: PlatformSchema,
  filename: z.string().min(1),
  url: z.string().url(),
  sha256: z.string().regex(SHA256_HEX),
  bytes: z.number().int().positive(),
  format: FormatSchema.optional(),
  executable: z.string().min(1).optional(),
  linkage: z.string().optional(),
});
export type TraceMakerAsset = z.infer<typeof TraceMakerAssetSchema>;

export const TraceMakerManifestSchema = z.object({
  name: z.literal("tracemaker"),
  builtAt: z.string().min(1),
  upstream: z.object({
    repository: z.string().min(1),
    tag: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/i),
    license: z.string().min(1),
    sourceUrl: z.string().url(),
  }),
  assets: z.array(TraceMakerAssetSchema),
});
export type TraceMakerManifest = z.infer<typeof TraceMakerManifestSchema>;

export type TraceMakerBinaryRelease = {
  repo: string;
  tag: string;
  manifestUrl: string;
};

export type ResolvedTraceMakerArtifact = {
  artifact: RouterArtifact;
  origin: "binary" | "source";
  platform: TraceMakerPlatform | null;
  version?: string;
  warning?: string;
};

export function detectTraceMakerPlatform(opts?: {
  platform?: string;
  arch?: string;
}): TraceMakerPlatform | null {
  const platform = opts?.platform ?? process.platform;
  const arch = opts?.arch ?? process.arch;
  if (platform === "linux" && (arch === "x64" || arch === "x86_64")) return "linux-x86_64";
  if (platform === "darwin" && (arch === "arm64" || arch === "aarch64")) return "macos-arm64";
  if (platform === "darwin" && (arch === "x64" || arch === "x86_64")) return "macos-x86_64";
  if ((platform === "win32" || platform === "windows") && (arch === "x64" || arch === "x86_64")) {
    return "windows-x86_64";
  }
  return null;
}

export function defaultTraceMakerBinaryRelease(
  env: NodeJS.ProcessEnv = process.env,
): TraceMakerBinaryRelease {
  const repo = env["FABDESK_TRACEMAKER_RELEASE_REPO"]?.trim() || TRACEMAKER_BINARY_RELEASE_REPO;
  const tag = env["FABDESK_TRACEMAKER_RELEASE_TAG"]?.trim() || TRACEMAKER_BINARY_RELEASE_TAG;
  const manifestUrl =
    env["FABDESK_TRACEMAKER_MANIFEST_URL"]?.trim() ||
    `https://github.com/${repo}/releases/download/${tag}/manifest.json`;
  return { repo, tag, manifestUrl };
}

export function parseTraceMakerManifest(raw: unknown): TraceMakerManifest {
  const parsed = TraceMakerManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`invalid TraceMaker manifest: ${parsed.error.issues[0]?.message ?? "schema error"}`);
  }
  return parsed.data;
}

export function selectTraceMakerAsset(
  manifest: TraceMakerManifest,
  platform: TraceMakerPlatform,
): TraceMakerAsset {
  const asset = manifest.assets.find((row) => row.platform === platform);
  if (!asset) {
    const available = manifest.assets.map((row) => row.platform).join(", ") || "none";
    throw new Error(
      `No TraceMaker binary is published for ${platform}. Published platforms: ${available}.`,
    );
  }
  return asset;
}

export function artifactFormatForFilename(filename: string): RouterArtifactFormat {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".jar")) return "jar";
  return "file";
}

export function traceMakerAssetToArtifact(asset: TraceMakerAsset): RouterArtifact {
  const format = asset.format ?? artifactFormatForFilename(asset.filename);
  const executable =
    asset.executable ?? (asset.platform === "windows-x86_64" ? "tracemaker.exe" : "tracemaker");
  return {
    url: asset.url,
    sha256: asset.sha256,
    bytes: asset.bytes,
    filename: asset.filename,
    format,
    executable,
  };
}

export async function fetchTraceMakerManifest(
  url: string,
  opts?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<TraceMakerManifest> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(url, { ...(opts?.signal ? { signal: opts.signal } : {}) });
  } catch (error) {
    throw offlineOrFetchError(error, url);
  }
  if (response.status === 404) throw new ManifestNotFoundError(url);
  if (!response.ok) throw new Error(`TraceMaker manifest download failed (${response.status}) from ${url}`);
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new Error(`TraceMaker manifest at ${url} is not valid JSON`);
  }
  return parseTraceMakerManifest(raw);
}

export class ManifestNotFoundError extends Error {
  constructor(url: string) {
    super(`TraceMaker binary manifest not published yet (${url})`);
    this.name = "ManifestNotFoundError";
  }
}

export class UnsupportedTraceMakerPlatformError extends Error {
  readonly platform: string;
  constructor(platform: string) {
    super(
      `No TraceMaker binary is published for ${platform}. Install falls back to the upstream source tarball, or set TRACEMAKER_BIN.`,
    );
    this.name = "UnsupportedTraceMakerPlatformError";
    this.platform = platform;
  }
}

/**
 * Prefer a checksum-verified platform binary from our weekly GitHub release.
 * Falls back to the catalog source tarball when the rolling release is missing
 * or has no asset for this OS/arch. `FABDESK_TRACEMAKER_URL` keeps tests and
 * power users on an explicit artifact.
 */
export async function resolveTraceMakerInstallArtifact(opts: {
  source: RouterArtifact;
  binaryRelease?: TraceMakerBinaryRelease;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  platform?: string;
  arch?: string;
  signal?: AbortSignal;
}): Promise<ResolvedTraceMakerArtifact> {
  const env = opts.env ?? process.env;
  const detected = detectTraceMakerPlatform({
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.arch ? { arch: opts.arch } : {}),
  });
  if (env["FABDESK_TRACEMAKER_URL"]?.trim() || !opts.binaryRelease) {
    return {
      artifact: opts.source,
      origin: "source",
      platform: detected,
    };
  }
  if (!detected) {
    const label = `${opts.platform ?? process.platform}-${opts.arch ?? process.arch}`;
    return {
      artifact: opts.source,
      origin: "source",
      platform: null,
      warning: new UnsupportedTraceMakerPlatformError(label).message,
    };
  }
  try {
    const manifest = await fetchTraceMakerManifest(opts.binaryRelease.manifestUrl, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const asset = selectTraceMakerAsset(manifest, detected);
    return {
      artifact: traceMakerAssetToArtifact(asset),
      origin: "binary",
      platform: detected,
      version: manifest.upstream.tag.replace(/^v/, ""),
    };
  } catch (error) {
    if (error instanceof ManifestNotFoundError || isMissingPlatform(error)) {
      return {
        artifact: opts.source,
        origin: "source",
        platform: detected,
        warning: error instanceof Error ? error.message : String(error),
      };
    }
    throw error;
  }
}

function isMissingPlatform(error: unknown): boolean {
  return error instanceof Error && /No TraceMaker binary is published for /.test(error.message);
}
