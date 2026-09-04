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

export const OrderReadiness = z.object({
  ready: z.boolean(),
  hasGerbers: z.boolean(),
  hasFabricationZip: z.boolean(),
  hasRouted: z.boolean(),
  hasKicadPcb: z.boolean(),
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
