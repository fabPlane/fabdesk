import { z } from "zod/v4";
import { ProjectDetail } from "./api";

export const OpenCatalogSource = z.object({
  provider: z.literal("github"),
  owner: z.string(),
  repository: z.string(),
  url: z.string(),
  license: z.string(),
});

export const OpenCatalogEntry = z.object({
  id: z.string().min(1),
  visibility: z.literal("public").optional(),
  ownerSlug: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  defaultBranch: z.string().optional(),
  updatedAt: z.string().optional(),
  cloneUrl: z.string(),
  homepageUrl: z.string().optional(),
  previewUrl: z.string(),
  heroUrl: z.string().optional(),
  /** Rehosted original board photo / logo. Primary catalog tile is `previewUrl` (3D). */
  photoUrl: z.string().optional(),
  modelUrl: z.string().optional(),
  overview: z.string().optional(),
  lede: z.string().optional(),
  tags: z.array(z.string()).optional(),
  highlights: z.array(z.string()).optional(),
  source: OpenCatalogSource.optional(),
  gallery: z.array(z.object({ alt: z.string(), url: z.string() })).optional(),
});
export type OpenCatalogEntry = z.infer<typeof OpenCatalogEntry>;

export const OpenCatalogIndex = z.object({
  generatedAt: z.string(),
  source: z.enum(["r2-list", "seed", "merge", "api"]),
  projects: z.array(OpenCatalogEntry),
});
export type OpenCatalogIndex = z.infer<typeof OpenCatalogIndex>;

export const RemixOpenSource = z.object({
  id: z.string().min(1),
});

export const RemixResult = z.object({
  project: ProjectDetail,
  sourceId: z.string(),
  pcbPath: z.string().optional(),
});
export type RemixResult = z.infer<typeof RemixResult>;

export const OrderVendorId = z.enum(["jlcpcb", "pcbway", "laser", "cnc"]);
export type OrderVendorId = z.infer<typeof OrderVendorId>;

export const OrderCheckStatus = z.enum(["not_required", "missing", "stale", "pass", "fail"]);
export type OrderCheckStatus = z.infer<typeof OrderCheckStatus>;

export const OrderReadiness = z.object({
  ready: z.boolean(),
  hasGerbers: z.boolean(),
  hasFabricationZip: z.boolean(),
  hasRouted: z.boolean(),
  hasKicadPcb: z.boolean(),
  /** Freshness and pass state of the release gate's saved-file DRC/ERC reports. */
  checks: z.object({ drc: OrderCheckStatus, erc: OrderCheckStatus }),
  reasons: z.array(z.string()),
});
export type OrderReadiness = z.infer<typeof OrderReadiness>;

export const StartOrder = z.object({
  vendor: OrderVendorId,
});

export const OrderStep = z.object({
  title: z.string(),
  body: z.string(),
});

export const OrderSession = z.object({
  vendor: OrderVendorId,
  label: z.string(),
  enabled: z.boolean(),
  orderUrl: z.string().optional(),
  steps: z.array(OrderStep),
});
export type OrderSession = z.infer<typeof OrderSession>;

/** Images CDN custom domain for catalog preview/photo objects. Not the website. */
export const DEFAULT_CATALOG_PUBLIC_ORIGIN = "https://images.fabplane.com";
/** Public path matches the R2 object key: /artifacts/open-catalog/{owner}/{slug}/{file}. */
export const OPEN_CATALOG_PREFIX = "artifacts/open-catalog";
export const CATALOG_PUBLIC_PREFIX = `/${OPEN_CATALOG_PREFIX}`;

const WEBSITE_ORIGINS = new Set([
  "https://fabplane.com",
  "http://fabplane.com",
  "https://www.fabplane.com",
  "http://www.fabplane.com",
]);

function envOrigin(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  const value = env?.[name]?.trim().replace(/\/+$/, "");
  if (!value || WEBSITE_ORIGINS.has(value)) return undefined;
  return value;
}

/** Images CDN origin. Override with CATALOG_PUBLIC_ORIGIN, IMAGES_PUBLIC_BASE, ARTIFACT_PUBLIC_BASE, or PUBLIC_ARTIFACT_CDN_URL. */
export function catalogPublicOrigin(): string {
  return (
    envOrigin("CATALOG_PUBLIC_ORIGIN") ??
    envOrigin("IMAGES_PUBLIC_BASE") ??
    envOrigin("ARTIFACT_PUBLIC_BASE") ??
    envOrigin("PUBLIC_ARTIFACT_CDN_URL") ??
    DEFAULT_CATALOG_PUBLIC_ORIGIN
  );
}

/** Resolved at import for committed seed URLs. Prefer `catalogPublicOrigin()` at runtime. */
export const CATALOG_PUBLIC_ORIGIN = catalogPublicOrigin();

export function catalogHostedUrl(ownerSlug: string, slug: string, file: "preview.webp" | "photo.webp"): string {
  return `${catalogPublicOrigin()}${CATALOG_PUBLIC_PREFIX}/${ownerSlug}/${slug}/${file}`;
}

export function isCatalogWebsiteAsset(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "fabplane.com" || host === "www.fabplane.com";
  } catch {
    return false;
  }
}

export function catalogPreviewUrl(ownerSlug: string, slug: string): string {
  return catalogHostedUrl(ownerSlug, slug, "preview.webp");
}

export function catalogPhotoUrl(ownerSlug: string, slug: string): string {
  return catalogHostedUrl(ownerSlug, slug, "photo.webp");
}

export function isGitHubAssetHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === "github.com" ||
      host.endsWith(".github.com") ||
      host === "raw.githubusercontent.com" ||
      host.endsWith(".githubusercontent.com")
    );
  } catch {
    return false;
  }
}

/** Two-letter tile used when a catalog preview image is missing or fails to load. */
export function catalogInitials(name: string): string {
  const words = name
    .trim()
    .split(/[\s/_-]+/)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, ""))
    .filter(Boolean);
  if (words.length >= 2) {
    const first = words[0]?.[0] ?? "?";
    const second = words[1]?.[0] ?? "";
    return `${first}${second}`.toUpperCase();
  }
  const single = words[0] ?? "?";
  return (single.slice(0, 2) || "?").toUpperCase();
}
