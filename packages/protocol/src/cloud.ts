/**
 * fabplane.com orgs, purchase destinations, carts (shopping lists) and inventory — the v1 API
 * contract shared with fabplane.com and `fabplane-cli`. Response shapes are plain types (the
 * server owns them); request bodies fabdesk-core accepts on its own routes are zod schemas.
 */
import { z } from "zod/v4";

export type OrgRole = "owner" | "admin" | "member";

export type Org = {
  id: string;
  slug: string;
  name: string;
  personal: boolean;
  role: OrgRole;
  memberCount: number;
  domainJoin: { domain: string; enabled: boolean } | null;
  createdAt: string;
};

export type DestinationKind = "fab" | "distributor" | "manual";

export type Destination = {
  id: string;
  name: string;
  kind: DestinationKind;
  url: string | null;
  builtin: boolean;
  baseId: string | null;
};

export type CartItemStatus = "needed" | "ordered" | "received";
export const CART_ITEM_STATUSES: readonly CartItemStatus[] = ["needed", "ordered", "received"];

export const CartItemInput = z.object({
  kind: z.enum(["pcb", "part", "other"]).optional(),
  mpn: z.string().max(200).optional(),
  manufacturer: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  value: z.string().max(200).optional(),
  footprint: z.string().max(300).optional(),
  refs: z.array(z.string()).max(500).optional(),
  quantity: z.number().int().min(0),
  destinationId: z.string().optional(),
  sku: z.string().max(200).optional(),
  url: z.string().max(2000).optional(),
  unitPrice: z.number().min(0).optional(),
  currency: z.string().length(3).optional(),
  status: z.enum(["needed", "ordered", "received"]).optional(),
  notes: z.string().max(4000).optional(),
  inventoryItemId: z.string().nullable().optional(),
});
export type CartItemInput = z.infer<typeof CartItemInput>;
export const CartItemPatch = CartItemInput.partial();
export type CartItemPatch = z.infer<typeof CartItemPatch>;

export type CartItem = Omit<CartItemInput, "kind" | "quantity" | "status" | "destinationId"> & {
  id: string;
  kind: "pcb" | "part" | "other";
  quantity: number;
  status: CartItemStatus;
  destinationId: string;
  createdAt: string;
  updatedAt: string;
};

export type CartSummary = {
  id: string;
  orgId: string;
  name: string;
  repos: string[];
  projectId: string | null;
  fabDestinationId: string;
  itemCount: number;
  updatedAt: string;
  createdAt: string;
};

export type Cart = CartSummary & {
  notes: string | null;
  items: CartItem[];
  byDestination: { destinationId: string; itemCount: number; totalQuantity: number }[];
};

export type CreateCartInput = {
  name: string;
  repos?: string[];
  projectId?: string;
  notes?: string;
  fabDestinationId?: string;
};

export type UpdateCartInput = {
  name?: string;
  repos?: string[];
  projectId?: string | null;
  notes?: string;
  fabDestinationId?: string;
};

export const CreateDestinationInput = z.object({
  name: z.string().min(1).max(80),
  url: z.string().url(),
  kind: z.enum(["fab", "distributor", "manual"]).optional(),
  baseId: z.string().startsWith("builtin:").optional(),
});
export type CreateDestinationInput = z.infer<typeof CreateDestinationInput>;

export const InventoryAttributeValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const InventoryItemInput = z.object({
  name: z.string().min(1).max(200),
  mpn: z.string().max(200).optional(),
  manufacturer: z.string().max(200).optional(),
  sku: z.string().max(200).optional(),
  category: z.string().max(200).optional(),
  description: z.string().max(4000).optional(),
  quantity: z.number().int().min(0).optional(),
  unit: z.string().max(40).optional(),
  location: z.string().max(200).optional(),
  tags: z.array(z.string().max(80)).max(50).optional(),
  attributes: z.record(z.string(), InventoryAttributeValue).optional(),
  source: z.string().max(80).optional(),
  externalId: z.string().max(200).optional(),
  /** Always false from fabdesk: the server answers 501; fields come from the local agent instead. */
  serverAiProcessing: z.boolean().optional(),
});
export type InventoryItemInput = z.infer<typeof InventoryItemInput>;

export type InventoryImage = {
  id: string;
  contentType: string;
  bytes: number;
  url: string;
  createdAt: string;
};

export type InventoryItem = Omit<InventoryItemInput, "serverAiProcessing"> & {
  id: string;
  orgId: string;
  quantity: number;
  unit: string;
  tags: string[];
  attributes: Record<string, unknown>;
  images: InventoryImage[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type InventoryQuery = {
  q?: string;
  category?: string;
  location?: string;
  tag?: string;
  limit?: number;
  cursor?: string;
};

export const InventoryAdjust = z.object({
  delta: z
    .number()
    .int()
    .refine((n) => n !== 0, "delta must not be 0"),
  reason: z.string().max(500).optional(),
});

/** `GET /cloud/status` on fabdesk-core. */
export type CloudStatus = {
  /** False when this build has no fabplane client or runs in local auth mode. */
  available: boolean;
  signedIn: boolean;
  orgs: Org[];
  activeOrgId: string | null;
  /** fabplane dashboard root derived from the core's API origin. */
  dashboardUrl: string;
  error?: string;
};

/** `GET /projects/:id/shopping-list` on fabdesk-core. */
export type ShoppingListResponse = {
  orgId: string;
  cart: Cart | null;
  /** Dashboard page for the cart, when one exists. */
  cartUrl: string | null;
};

export type BomSyncSummary = {
  parts: number;
  matched: number;
  added: number;
  removed: number;
  kept: number;
  pcbAdded: boolean;
};

export const BUILTIN_DESTINATIONS: readonly Destination[] = [
  ["jlcpcb", "JLCPCB", "fab", "https://jlcpcb.com"],
  ["pcbway", "PCBWay", "fab", "https://www.pcbway.com"],
  ["oshpark", "OSH Park", "fab", "https://oshpark.com"],
  ["digikey", "DigiKey", "distributor", "https://www.digikey.com"],
  ["mouser", "Mouser", "distributor", "https://www.mouser.com"],
  ["lcsc", "LCSC", "distributor", "https://www.lcsc.com"],
  ["arrow", "Arrow", "distributor", "https://www.arrow.com"],
  ["farnell", "Farnell / element14", "distributor", "https://www.farnell.com"],
  ["aliexpress", "AliExpress", "distributor", "https://www.aliexpress.com"],
  ["amazon", "Amazon", "distributor", "https://www.amazon.com"],
  ["manual", "Manual purchase", "manual", null],
].map(([key, name, kind, url]) => ({
  id: `builtin:${key}`,
  name: name as string,
  kind: kind as DestinationKind,
  url: url as string | null,
  builtin: true,
  baseId: null,
}));

export const DEFAULT_FAB_DESTINATION = "builtin:jlcpcb";
export const MANUAL_DESTINATION = "builtin:manual";

/**
 * Find a destination by id (`builtin:digikey`, a custom uuid), bare built-in key (`digikey`) or
 * name, case-insensitively (`"DigiKey Thailand"`). Null when nothing matches.
 */
export function matchDestination(
  ref: string,
  destinations: readonly Destination[],
): Destination | null {
  const want = ref.trim().toLowerCase();
  if (!want) return null;
  return (
    destinations.find((d) => d.id.toLowerCase() === want) ??
    destinations.find((d) => d.builtin && d.id.toLowerCase() === `builtin:${want}`) ??
    destinations.find((d) => d.name.toLowerCase() === want) ??
    null
  );
}

/**
 * fabplane dashboard root for an API origin (contract rule): `api.fabplane.com` →
 * `app.fabplane.com/dashboard`; `:4000` → `:5173/dashboard`; localhost → `localhost:5173`;
 * otherwise a leading `api.` becomes `app.`.
 */
export function dashboardUrlFor(apiOrigin: string): string {
  let u: URL;
  try {
    u = new URL(apiOrigin);
  } catch {
    return "https://app.fabplane.com/dashboard";
  }
  if (u.port === "4000") return `${u.protocol}//${u.hostname}:5173/dashboard`;
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1")
    return `http://${u.hostname}:5173/dashboard`;
  const host = u.hostname.startsWith("api.") ? `app.${u.hostname.slice(4)}` : u.hostname;
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ""}/dashboard`;
}

export function cartDashboardUrl(dashboardUrl: string, cartId: string): string {
  return `${dashboardUrl.replace(/\/+$/, "")}/carts/${encodeURIComponent(cartId)}`;
}
