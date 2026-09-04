import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  catalogInitials,
  catalogPhotoUrl,
  catalogPreviewUrl,
  isGitHubAssetHost,
  type OpenCatalogEntry,
} from "@fabdesk/protocol";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PreviewImage = { body: Uint8Array; contentType: string };

export type PreviewCache = Map<string, PreviewImage & { expiresAt: number }>;

export type PreviewRole = "preview" | "hero";

export const MAX_PREVIEW_BYTES = 5_000_000;
const CACHE_MS = 6 * 60 * 60 * 1000;
const FALLBACK_CACHE_MS = 5 * 60 * 1000;
const FETCH_MS = 5_000;

const PREVIEW_UA = "FabdeskCatalog/1.0 (+https://github.com/TensorFleet/fabdesk)";

const TRUSTED_PREVIEW_HOSTS = new Set(["images.fabplane.com", "fabplane.com", "www.fabplane.com"]);

/** Reject loopback, link-local, RFC1918, and IPv6 unique-local / link-local hosts. */
export function isPrivatePreviewHost(host: string): boolean {
  const name = host.toLowerCase();
  if (name === "localhost" || name.endsWith(".localhost") || name.endsWith(".local") || name.endsWith(".internal")) {
    return true;
  }
  const ipv4 = name.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (name === "::1" || name.startsWith("fe80:") || name.startsWith("fc") || name.startsWith("fd")) return true;
  return false;
}

/** HTTPS catalog/CDN hosts only. Private destinations are rejected even if they look public. */
export function isTrustedPreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (isPrivatePreviewHost(host)) return false;
    return TRUSTED_PREVIEW_HOSTS.has(host);
  } catch {
    return false;
  }
}

export function createPreviewCache(): PreviewCache {
  return new Map();
}

export function isRateLimitedPreviewHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "opengraph.github.com" || host === "opengraph.githubassets.com";
  } catch {
    return false;
  }
}

export function catalogAssetDir(): string | undefined {
  const dir = process.env["CATALOG_ASSET_DIR"]?.trim();
  return dir ? dir : undefined;
}

export function localCatalogAssetPath(project: OpenCatalogEntry, file: "preview.webp" | "photo.webp"): string | undefined {
  const root = catalogAssetDir();
  if (!root) return undefined;
  const path = join(root, project.ownerSlug, project.slug, file);
  return existsSync(path) ? path : undefined;
}

/** Hosted 3D preview first, then hero/photo. Never prefer GitHub hosts. */
export function previewCandidateUrls(project: OpenCatalogEntry, role: PreviewRole = "preview"): string[] {
  const urls: string[] = [];
  const add = (url: string | undefined) => {
    if (!url || urls.includes(url) || isGitHubAssetHost(url) || isRateLimitedPreviewHost(url)) return;
    urls.push(url);
  };
  if (role === "hero") {
    add(project.heroUrl);
    add(project.previewUrl);
  } else {
    add(project.previewUrl);
    add(project.heroUrl);
  }
  add(project.photoUrl);
  // Seed/CDN paths so a GitHub-backed production catalog still resolves after images deploy.
  add(catalogPreviewUrl(project.ownerSlug, project.slug));
  add(catalogPhotoUrl(project.ownerSlug, project.slug));
  return urls;
}

/** Read an image body, aborting once it exceeds `maxBytes` instead of buffering the rest. */
export async function readCappedBody(res: Response, maxBytes = MAX_PREVIEW_BYTES): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.length > maxBytes ? null : bytes;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  const head = new TextDecoder().decode(bytes.slice(0, 80)).trimStart().toLowerCase();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml";
  return null;
}

export function fallbackPreviewSvg(name: string): PreviewImage {
  const initials = catalogInitials(name);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-label="${initials}">
  <rect width="64" height="64" rx="12" fill="#1e211d"/>
  <rect x="0.5" y="0.5" width="63" height="63" rx="12" fill="none" stroke="#30362e"/>
  <text x="32" y="39" text-anchor="middle" font-family="ui-sans-serif,system-ui,sans-serif" font-size="20" font-weight="600" fill="#a5aea0">${initials}</text>
</svg>
`;
  return { body: new TextEncoder().encode(svg), contentType: "image/svg+xml; charset=utf-8" };
}

export async function resolveCatalogPreview(
  project: OpenCatalogEntry,
  opts: { fetchImpl?: FetchLike; cache?: PreviewCache; now?: number; role?: PreviewRole } = {},
): Promise<PreviewImage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cache = opts.cache;
  const now = opts.now ?? Date.now();
  const role = opts.role ?? "preview";
  const cacheKey = `${project.id}:${role}`;
  const hit = cache?.get(cacheKey);
  if (hit && hit.expiresAt > now) return { body: hit.body, contentType: hit.contentType };

  const local = localCatalogAssetPath(project, "preview.webp") ?? localCatalogAssetPath(project, "photo.webp");
  if (local) {
    const bytes = new Uint8Array(await Bun.file(local).arrayBuffer());
    const sniffed = sniffImageType(bytes);
    if (sniffed) {
      const image = { body: bytes, contentType: sniffed };
      cache?.set(cacheKey, { ...image, expiresAt: now + CACHE_MS });
      return image;
    }
  }

  for (const url of previewCandidateUrls(project, role)) {
    if (!isTrustedPreviewUrl(url)) continue;
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_MS),
        headers: { Accept: "image/*,*/*;q=0.8", "User-Agent": PREVIEW_UA },
      });
      const finalUrl = res.url || url;
      if (finalUrl && !isTrustedPreviewUrl(finalUrl)) continue;
      if (!res.ok) continue;
      const bytes = await readCappedBody(res);
      if (!bytes || bytes.length < 16) continue;
      const sniffed = sniffImageType(bytes);
      if (!sniffed) continue;
      const declared = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const contentType = declared.startsWith("image/") ? declared : sniffed;
      const image = { body: bytes, contentType };
      cache?.set(cacheKey, { ...image, expiresAt: now + CACHE_MS });
      return image;
    } catch {
      /* try the next candidate */
    }
  }

  const fallback = fallbackPreviewSvg(project.name);
  cache?.set(cacheKey, { ...fallback, expiresAt: now + FALLBACK_CACHE_MS });
  return fallback;
}
