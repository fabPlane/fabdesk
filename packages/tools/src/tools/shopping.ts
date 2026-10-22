/**
 * Shopping toolset: the project's fabplane.com shopping list (an org cart linked to the project)
 * and the team's parts inventory. Every tool needs a fabplane sign-in; the daemon calls the API.
 */
import { z } from "zod/v4";
import {
  BUILTIN_DESTINATIONS,
  matchDestination,
  type Cart,
  type CartItemInput,
  type CartItemPatch,
  type Destination,
  type InventoryItem,
} from "@fabdesk/protocol";
import { ToolError, defineTool, type ToolContext } from "../registry";
import { cloudToolError } from "../cloud/api";
import type { CloudService } from "../cloud/service";
import { ok, table } from "./common";

async function withCloud<T>(ctx: ToolContext, fn: (cloud: CloudService) => Promise<T>): Promise<T> {
  const cloud = ctx.services.cloud;
  if (!cloud)
    throw new ToolError(
      "fabplane.com is not connected to this fabdesk daemon. Sign in to fabplane (Settings → Account in the fabPlane app) to use shopping lists and inventory.",
      "unavailable",
    );
  try {
    return await fn(cloud);
  } catch (e) {
    throw cloudToolError(e);
  }
}

const destinationName = (id: string, list: readonly Destination[]): string =>
  list.find((d) => d.id === id)?.name ?? BUILTIN_DESTINATIONS.find((d) => d.id === id)?.name ?? id;

/** Resolve a destination the agent named (id, built-in key or name) against the org's list. */
async function resolveDestination(cloud: CloudService, ref: string): Promise<string> {
  const list = await cloud.destinations();
  const hit = matchDestination(ref, list);
  if (!hit)
    throw new ToolError(
      `unknown destination "${ref}". Known: ${list.map((d) => `${d.name} (${d.id})`).join(", ")}. Add a custom one with shopping_list_destinations.`,
      "invalid_args",
    );
  return hit.id;
}

function cartText(
  cart: Cart,
  destinations: readonly Destination[],
  cartUrl: string | null,
): string {
  const byDest = new Map<string, Cart["items"]>();
  for (const item of cart.items) {
    const list = byDest.get(item.destinationId) ?? [];
    list.push(item);
    byDest.set(item.destinationId, list);
  }
  const lines = [
    `Shopping list "${cart.name}" (${cart.items.length} line${cart.items.length === 1 ? "" : "s"})${cartUrl ? ` — ${cartUrl}` : ""}`,
  ];
  if (cart.repos.length) lines.push(`Repos: ${cart.repos.join(", ")}`);
  for (const [dest, items] of byDest) {
    lines.push("", `### ${destinationName(dest, destinations)} (${dest})`);
    lines.push(
      table(
        items.map((i) => ({
          id: i.id,
          kind: i.kind,
          qty: i.quantity,
          part: i.mpn ?? i.value ?? i.description ?? "",
          footprint: i.footprint ?? "",
          refs: (i.refs ?? []).join(" "),
          status: i.status,
          notes: i.notes ?? "",
        })),
        ["id", "kind", "qty", "part", "footprint", "refs", "status", "notes"],
      ),
    );
  }
  if (cart.items.length === 0) lines.push("", "(empty)");
  return lines.join("\n");
}

const itemFields = {
  kind: z
    .enum(["pcb", "part", "other"])
    .optional()
    .describe(
      '"part" (default) for components, "pcb" for the bare board order, "other" for tools/consumables',
    ),
  mpn: z.string().max(200).optional().describe("Manufacturer part number"),
  manufacturer: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  value: z.string().max(200).optional().describe('Component value, e.g. "10k", "100nF"'),
  footprint: z
    .string()
    .max(300)
    .optional()
    .describe('KiCad footprint, e.g. "Resistor_SMD:R_0603_1608Metric"'),
  refs: z.array(z.string()).max(500).optional().describe('Designators, e.g. ["R1","R2"]'),
  destination: z
    .string()
    .optional()
    .describe(
      'Where to buy it: a destination id ("builtin:digikey", a custom uuid), built-in key ("jlcpcb", "manual") or name ("DigiKey Thailand"). Default: the cart\'s fab house (JLCPCB), which assembles/sources everything not moved elsewhere.',
    ),
  sku: z.string().max(200).optional().describe("Distributor part number or LCSC C-number"),
  url: z.string().max(2000).optional().describe("Product page"),
  unitPrice: z.number().min(0).optional(),
  currency: z.string().length(3).optional().describe("ISO 4217, e.g. USD, THB"),
  status: z.enum(["needed", "ordered", "received"]).optional(),
  notes: z.string().max(4000).optional(),
};

type ItemArgs = { destination?: string | undefined } & Record<string, unknown>;

async function toItemInput(
  cloud: CloudService,
  args: ItemArgs,
  cache: Map<string, string>,
): Promise<Record<string, unknown>> {
  const { destination, ...rest } = args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) out[k] = v;
  if (destination) {
    let id = cache.get(destination);
    if (!id) {
      id = await resolveDestination(cloud, destination);
      cache.set(destination, id);
    }
    out["destinationId"] = id;
  }
  return out;
}

export const shopping_list_get = defineTool({
  name: "shopping_list_get",
  toolset: "shopping",
  title: "Get the project's shopping list",
  description:
    "Show the project's fabplane.com shopping list (BOM cart): every line grouped by purchase destination (JLCPCB, Manual purchase, DigiKey, custom ones like DigiKey Thailand) with item ids, quantities, refs, status (needed/ordered/received) and notes, plus the dashboard link. Returns cart: null when the project has no list yet (shopping_list_add or shopping_list_sync_bom create it). Requires fabplane sign-in.",
  inputSchema: {},
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) =>
    withCloud(ctx, async (cloud) => {
      const project = ctx.requireProject();
      const list = await cloud.shoppingList(project);
      if (!list.cart)
        return ok(
          `Project "${project.name}" has no shopping list yet. shopping_list_sync_bom builds one from the netlist and off-board parts; shopping_list_add creates it with the given items.`,
          list,
        );
      const destinations = await cloud.destinations().catch(() => [] as Destination[]);
      return ok(cartText(list.cart, destinations, list.cartUrl), list);
    }),
});

export const shopping_list_add = defineTool({
  name: "shopping_list_add",
  toolset: "shopping",
  title: "Add items to the shopping list",
  description:
    'Append lines to the project\'s shopping list, creating the list if the project has none yet (named after the project and tagged with its git remotes). Use for parts not in the netlist, spares, tools, or a specific distributor listing. Each item needs a quantity; set destination to route it to a distributor or "manual". Items without refs are kept across BOM re-syncs. Returns the added items and the updated list.',
  inputSchema: {
    items: z
      .array(z.object({ ...itemFields, quantity: z.number().int().min(0) }))
      .min(1)
      .max(500),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async ({ items }, ctx) =>
    withCloud(ctx, async (cloud) => {
      const project = ctx.requireProject();
      const cache = new Map<string, string>();
      const inputs: CartItemInput[] = [];
      for (const item of items)
        inputs.push((await toItemInput(cloud, item, cache)) as CartItemInput);
      const res = await cloud.addItems(project, inputs);
      const destinations = await cloud.destinations().catch(() => [] as Destination[]);
      return ok(
        `Added ${res.added.length} item${res.added.length === 1 ? "" : "s"}.\n\n${cartText(res.cart, destinations, res.cartUrl)}`,
        res,
      );
    }),
});

export const shopping_list_update = defineTool({
  name: "shopping_list_update",
  toolset: "shopping",
  title: "Update a shopping list item",
  description:
    'Change one shopping-list line by item id (from shopping_list_get): quantity, destination (move it from JLCPCB to a distributor or "manual"), status (needed → ordered → received), notes, sku/url/price or part fields. Only the fields you pass change. BOM re-syncs keep destination, status and notes.',
  inputSchema: {
    itemId: z.string().min(1).describe("Item id from shopping_list_get"),
    ...itemFields,
    quantity: z.number().int().min(0).optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async ({ itemId, ...patch }, ctx) =>
    withCloud(ctx, async (cloud) => {
      const project = ctx.requireProject();
      const body = (await toItemInput(cloud, patch, new Map())) as CartItemPatch;
      if (Object.keys(body).length === 0)
        throw new ToolError("nothing to update: pass at least one field", "invalid_args");
      const item = await cloud.updateItem(project, itemId, body);
      return ok(
        `Updated ${item.id}: ${item.quantity} × ${item.mpn ?? item.value ?? item.description ?? item.kind} → ${item.destinationId}, ${item.status}.`,
        { item },
      );
    }),
});

export const shopping_list_remove = defineTool({
  name: "shopping_list_remove",
  toolset: "shopping",
  title: "Remove a shopping list item",
  description:
    "Delete one line from the project's shopping list by item id. A line that came from the BOM returns on the next shopping_list_sync_bom unless the part is removed from the design; set quantity 0 instead to keep it out.",
  inputSchema: { itemId: z.string().min(1).describe("Item id from shopping_list_get") },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async ({ itemId }, ctx) =>
    withCloud(ctx, async (cloud) => {
      const project = ctx.requireProject();
      await cloud.removeItem(project, itemId);
      return ok(`Removed ${itemId}.`, { removed: itemId });
    }),
});

export const shopping_list_sync_bom = defineTool({
  name: "shopping_list_sync_bom",
  toolset: "shopping",
  title: "Sync the shopping list from the BOM",
  description:
    'Rebuild the part lines of the project\'s shopping list from circuit.netlist.json and project.parts.json: electrical components grouped by value + footprint + MPN/manufacturer, plus off-board motors/displays/hardware (quantity from the off-board line). Lines matched to the previous sync (by MPN, else value + footprint) keep their destination, status and notes; hand-added lines are kept; parts no longer in the design are dropped. Adds a "PCB – <project>" × 5 line at the fab house if there is none. Creates the list on first use.',
  inputSchema: {},
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (_args, ctx) =>
    withCloud(ctx, async (cloud) => {
      const project = ctx.requireProject();
      const res = await cloud.syncBom(project);
      const s = res.summary;
      const destinations = await cloud.destinations().catch(() => [] as Destination[]);
      return ok(
        `BOM synced: ${s.parts} part lines (${s.matched} kept their edits, ${s.added} new, ${s.removed} removed), ${s.kept} other lines kept${s.pcbAdded ? ", PCB line added" : ""}.\n\n${cartText(res.cart, destinations, res.cartUrl)}`,
        res,
      );
    }),
});

export const shopping_list_destinations = defineTool({
  name: "shopping_list_destinations",
  toolset: "shopping",
  scope: "global",
  title: "List or add purchase destinations",
  description:
    'List where shopping-list items can be bought: built-in fab houses (JLCPCB, PCBWay, OSH Park), distributors (DigiKey, Mouser, LCSC, …), "Manual purchase", and the org\'s custom destinations. Pass `add` to create a custom destination (org admins only), e.g. { name: "DigiKey Thailand", url: "https://www.digikey.co.th", baseId: "builtin:digikey" }.',
  inputSchema: {
    add: z
      .object({
        name: z.string().min(1).max(80),
        url: z.string().url().describe("Storefront URL (http/https)"),
        kind: z.enum(["fab", "distributor", "manual"]).optional().describe("Default distributor"),
        baseId: z
          .string()
          .startsWith("builtin:")
          .optional()
          .describe('Built-in destination this is a regional variant of, e.g. "builtin:digikey"'),
      })
      .optional()
      .describe("Create this custom destination first"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async ({ add }, ctx) =>
    withCloud(ctx, async (cloud) => {
      const created = add
        ? await cloud.addDestination({
            name: add.name,
            url: add.url,
            ...(add.kind ? { kind: add.kind } : {}),
            ...(add.baseId ? { baseId: add.baseId } : {}),
          })
        : null;
      const destinations = await cloud.destinations();
      return ok(
        `${created ? `Added destination ${created.name} (${created.id}).\n\n` : ""}${table(
          destinations.map((d) => ({ id: d.id, name: d.name, kind: d.kind, url: d.url ?? "" })),
          ["id", "name", "kind", "url"],
        )}`,
        { destinations, ...(created ? { created } : {}) },
      );
    }),
});

const inventoryRow = (i: InventoryItem) => ({
  id: i.id,
  name: i.name,
  mpn: i.mpn ?? "",
  qty: `${i.quantity} ${i.unit}`,
  location: i.location ?? "",
  tags: i.tags.join(", "),
});

export const inventory_search = defineTool({
  name: "inventory_search",
  toolset: "shopping",
  scope: "global",
  title: "Search the team inventory",
  description:
    "Search the active fabplane org's parts inventory (what the team already has on the shelf) by text (name, MPN, manufacturer, description, SKU; case-insensitive) and optionally category, location or tag. Shows whether a part for the shopping list is already in stock. Returns items with id, quantity, unit, location, tags, attributes and image URLs; pass nextCursor back as cursor for more.",
  inputSchema: {
    q: z.string().max(200).optional().describe("Free-text query"),
    category: z.string().optional(),
    location: z.string().optional(),
    tag: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
    cursor: z.string().optional(),
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  },
  handler: async (args, ctx) =>
    withCloud(ctx, async (cloud) => {
      const query = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      const res = await cloud.searchInventory(query);
      return ok(
        `${res.items.length} inventory item${res.items.length === 1 ? "" : "s"}${res.nextCursor ? ` (more: cursor=${res.nextCursor})` : ""}.\n\n${table(res.items.map(inventoryRow), ["id", "name", "mpn", "qty", "location", "tags"])}`,
        res,
      );
    }),
});

export const inventory_add = defineTool({
  name: "inventory_add",
  toolset: "shopping",
  scope: "global",
  title: "Add an item to the team inventory",
  description:
    'Record a part the team has on hand in the active fabplane org\'s inventory. You (the local agent) do the extraction: read labels, photos or datasheets yourself and send the structured fields plus any semi-structured facts as `attributes` (e.g. { package: "SOT-23", voltage_v: 3.3, esd_sensitive: true }). The server does no AI processing. Pass externalId to make repeated adds idempotent (same externalId updates the existing item). Images are not uploaded by this tool.',
  inputSchema: {
    name: z.string().min(1).max(200).describe('Human name, e.g. "AMS1117-3.3 LDO"'),
    mpn: z.string().max(200).optional(),
    manufacturer: z.string().max(200).optional(),
    sku: z.string().max(200).optional(),
    category: z.string().max(200).optional().describe('e.g. "Voltage regulators"'),
    description: z.string().max(4000).optional(),
    quantity: z.number().int().min(0).optional().describe("Count on hand, default 0"),
    unit: z.string().max(40).optional().describe('Default "pcs"'),
    location: z.string().max(200).optional().describe('e.g. "Bangkok lab / drawer A3"'),
    tags: z.array(z.string().max(80)).max(50).optional(),
    attributes: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional()
      .describe("Semi-structured facts you extracted, ≤ 100 keys"),
    externalId: z.string().max(200).optional().describe("Idempotency key"),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: false,
    idempotentHint: false,
  },
  handler: async (args, ctx) =>
    withCloud(ctx, async (cloud) => {
      const input = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
      const item = await cloud.addInventoryItem(input as typeof args);
      return ok(`Inventory item ${item.name} (${item.id}): ${item.quantity} ${item.unit}.`, {
        item,
      });
    }),
});

export const shoppingTools = [
  shopping_list_get,
  shopping_list_add,
  shopping_list_update,
  shopping_list_remove,
  shopping_list_sync_bom,
  shopping_list_destinations,
  inventory_search,
  inventory_add,
] as const;
