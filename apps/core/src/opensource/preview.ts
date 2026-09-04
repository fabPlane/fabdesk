import { catalogInitials, type OpenCatalogEntry } from "@fabdesk/protocol";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PreviewImage = { body: Uint8Array; contentType: string };

export type PreviewCache = Map<string, PreviewImage & { expiresAt: number }>;

const MAX_BYTES = 5_000_000;
const CACHE_MS = 6 * 60 * 60 * 1000;
const FALLBACK_CACHE_MS = 5 * 60 * 1000;
const FETCH_MS = 5_000;

const PREVIEW_UA = "FabdeskCatalog/1.0 (+https://github.com/TensorFleet/fabdesk)";

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

export function githubAvatarUrl(owner: string): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}`;
}

/** Prefer board/CDN/raw URLs, then the GitHub avatar, and only then rate-limited Open Graph cards. */
export function previewCandidateUrls(project: OpenCatalogEntry): string[] {
  const urls: string[] = [];
  const add = (url: string | undefined) => {
    if (!url || urls.includes(url)) return;
    urls.push(url);
  };
  const preview = project.previewUrl;
  const hero = project.heroUrl;
  if (!isRateLimitedPreviewHost(preview)) add(preview);
  if (hero && !isRateLimitedPreviewHost(hero)) add(hero);
  add(githubAvatarUrl(project.source?.owner ?? project.ownerSlug));
  if (isRateLimitedPreviewHost(preview)) add(preview);
  if (hero && isRateLimitedPreviewHost(hero)) add(hero);
  return urls;
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
  opts: { fetchImpl?: FetchLike; cache?: PreviewCache; now?: number } = {},
): Promise<PreviewImage> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const cache = opts.cache;
  const now = opts.now ?? Date.now();
  const hit = cache?.get(project.id);
  if (hit && hit.expiresAt > now) return { body: hit.body, contentType: hit.contentType };

  for (const url of previewCandidateUrls(project)) {
    try {
      const res = await fetchImpl(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(FETCH_MS),
        headers: { Accept: "image/*,*/*;q=0.8", "User-Agent": PREVIEW_UA },
      });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 16 || bytes.length > MAX_BYTES) continue;
      const sniffed = sniffImageType(bytes);
      if (!sniffed) continue;
      const declared = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      const contentType = declared.startsWith("image/") ? declared : sniffed;
      const image = { body: bytes, contentType };
      cache?.set(project.id, { ...image, expiresAt: now + CACHE_MS });
      return image;
    } catch {
      /* try the next candidate */
    }
  }

  const fallback = fallbackPreviewSvg(project.name);
  cache?.set(project.id, { ...fallback, expiresAt: now + FALLBACK_CACHE_MS });
  return fallback;
}
