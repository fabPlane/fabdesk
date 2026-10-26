/**
 * Shopping-list lines from `circuit.netlist.json`, and the merge that keeps what the user changed
 * on the synced list (destination, status, notes, prices) across re-syncs. Pure functions.
 */
import type {
  BomSyncSummary,
  CartItem,
  CartItemInput,
  NetlistComponent,
  ProjectPartLine,
} from "@fabdesk/protocol";

/** `source` passed to `replaceCartItems` for a BOM sync. */
export const BOM_SOURCE = "fabdesk-bom";
export const DEFAULT_PCB_QUANTITY = 5;

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
/** R2 < R10 < U1. */
export const naturalCompare = (a: string, b: string): number => collator.compare(a, b);

/** Case-insensitive field lookup; empty and "~" values count as absent. */
export function fieldValue(
  fields: Record<string, string> | undefined,
  ...keys: string[]
): string | undefined {
  if (!fields) return undefined;
  const wanted = new Set(keys.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(fields)) {
    if (!wanted.has(k.trim().toLowerCase())) continue;
    const t = v.trim();
    if (t && t !== "~") return t;
  }
  return undefined;
}

const MPN_KEYS = ["mpn", "manufacturer part number", "manufacturer_part_number", "mfr part", "part number"];
const MANUFACTURER_KEYS = ["manufacturer", "mfr", "manufacturer name"];
const SKU_KEYS = ["lcsc", "lcsc part", "lcsc part #", "lcsc#"];
const DESCRIPTION_KEYS = ["description"];
const TRUTHY = new Set(["1", "true", "yes", "y", "x", "dnp"]);
const FALSY = new Set(["0", "false", "no", "n"]);

/** Virtual symbols (#PWR, #FLG) and do-not-populate / excluded-from-BOM parts are not bought. */
export function excludedFromBom(c: NetlistComponent): boolean {
  if (c.ref.startsWith("#")) return true;
  const dnp = fieldValue(c.fields, "dnp", "exclude_from_bom", "exclude from bom");
  if (dnp !== undefined && TRUTHY.has(dnp.toLowerCase())) return true;
  const inBom = fieldValue(c.fields, "in_bom");
  return inBom !== undefined && FALSY.has(inBom.toLowerCase());
}

const norm = (s: string | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * One part line per distinct value + footprint + MPN + manufacturer, quantity = count, refs sorted
 * naturally. Lines are ordered by their first ref.
 */
export function bomLinesFromNetlist(
  components: readonly NetlistComponent[],
  opts: { destinationId: string },
): CartItemInput[] {
  const groups = new Map<string, { c: NetlistComponent; refs: string[] }>();
  for (const c of components) {
    if (excludedFromBom(c)) continue;
    const mpn = fieldValue(c.fields, ...MPN_KEYS);
    const manufacturer = fieldValue(c.fields, ...MANUFACTURER_KEYS);
    const key = [norm(c.value), norm(c.footprint), norm(mpn), norm(manufacturer)].join("\u0000");
    const g = groups.get(key);
    if (g) g.refs.push(c.ref);
    else groups.set(key, { c, refs: [c.ref] });
  }
  const lines = [...groups.values()].map(({ c, refs }) => {
    const sorted = [...new Set(refs)].sort(naturalCompare);
    const mpn = fieldValue(c.fields, ...MPN_KEYS);
    const manufacturer = fieldValue(c.fields, ...MANUFACTURER_KEYS);
    const sku = fieldValue(c.fields, ...SKU_KEYS);
    const description = fieldValue(c.fields, ...DESCRIPTION_KEYS) ?? c.libSource?.description;
    const line: CartItemInput = {
      kind: "part",
      ...(c.value.trim() ? { value: c.value.trim() } : {}),
      ...(c.footprint.trim() ? { footprint: c.footprint.trim() } : {}),
      ...(mpn ? { mpn } : {}),
      ...(manufacturer ? { manufacturer } : {}),
      ...(sku ? { sku } : {}),
      ...(description ? { description } : {}),
      refs: sorted,
      quantity: sorted.length,
      destinationId: opts.destinationId,
    };
    return line;
  });
  return lines.sort((a, b) => naturalCompare(a.refs?.[0] ?? "", b.refs?.[0] ?? ""));
}

/**
 * One shopping-list line per off-board project part. Footprint is `offboard:<catalogId|kind>` so
 * re-syncs match without colliding with PCB footprints. Quantity is the line qty, not a ref count.
 */
export function bomLinesFromOffboard(
  parts: readonly ProjectPartLine[],
  opts: { destinationId: string },
): CartItemInput[] {
  return [...parts]
    .slice()
    .sort((a, b) => naturalCompare(a.ref, b.ref))
    .map((p) => {
      const description = `Off-board ${p.kind} · ${p.name}`;
      const line: CartItemInput = {
        kind: "part",
        value: p.name,
        footprint: `offboard:${p.catalogId ?? p.kind}`,
        description,
        refs: [p.ref],
        quantity: p.qty,
        destinationId: opts.destinationId,
        ...(p.mpn ? { mpn: p.mpn } : {}),
        ...(p.manufacturer ? { manufacturer: p.manufacturer } : {}),
        ...(p.notes ? { notes: p.notes } : {}),
      };
      return line;
    });
}

/** A server item back to an input: drops ids, timestamps and null fields. */
export function cartItemToInput(item: CartItem): CartItemInput {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = item;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) if (v !== null && v !== undefined) out[k] = v;
  return out as CartItemInput;
}

/** A BOM-synced line: a part that carries designators. Manual additions have no refs. */
const isSyncedPart = (i: CartItem): boolean => i.kind === "part" && (i.refs?.length ?? 0) > 0;

function matches(fresh: CartItemInput, old: CartItem): boolean {
  if (fresh.mpn && old.mpn) return norm(fresh.mpn) === norm(old.mpn);
  return (
    !!fresh.value &&
    !!fresh.footprint &&
    norm(fresh.value) === norm(old.value) &&
    norm(fresh.footprint) === norm(old.footprint)
  );
}

/**
 * The full item list for `replaceCartItems` after a BOM sync:
 * - fresh part lines, each keeping the destination, status, notes, sku, url, price and inventory
 *   link of the previously synced line it matches (by MPN, else value + footprint);
 * - previously synced lines that no longer match anything are dropped (the part left the design);
 * - everything the user added by hand (no refs, `pcb`, `other`) is kept as is;
 * - a `pcb` line "PCB – <project>" × 5 at the fab destination when there is none yet.
 */
export function mergeBomItems(
  fresh: readonly CartItemInput[],
  existing: readonly CartItem[],
  opts: { projectName: string; fabDestinationId: string },
): { items: CartItemInput[]; summary: BomSyncSummary } {
  const synced = existing.filter(isSyncedPart);
  const used = new Set<string>();
  let matched = 0;
  const parts = fresh.map((line) => {
    const old = synced.find((o) => !used.has(o.id) && matches(line, o));
    if (!old) return line;
    used.add(old.id);
    matched++;
    return {
      ...line,
      destinationId: old.destinationId,
      status: old.status,
      ...(old.notes ? { notes: old.notes } : {}),
      ...(!line.sku && old.sku ? { sku: old.sku } : {}),
      ...(old.url ? { url: old.url } : {}),
      ...(old.unitPrice !== undefined && old.unitPrice !== null ? { unitPrice: old.unitPrice } : {}),
      ...(old.currency ? { currency: old.currency } : {}),
      ...(old.inventoryItemId ? { inventoryItemId: old.inventoryItemId } : {}),
    } satisfies CartItemInput;
  });
  const kept = existing.filter((i) => !isSyncedPart(i)).map(cartItemToInput);
  const hasPcb = existing.some((i) => i.kind === "pcb");
  const pcb: CartItemInput[] = hasPcb
    ? []
    : [
        {
          kind: "pcb",
          description: `PCB – ${opts.projectName}`,
          quantity: DEFAULT_PCB_QUANTITY,
          destinationId: opts.fabDestinationId,
        },
      ];
  return {
    items: [...pcb, ...parts, ...kept],
    summary: {
      parts: parts.length,
      matched,
      added: parts.length - matched,
      removed: synced.length - used.size,
      kept: kept.length,
      pcbAdded: !hasPcb,
    },
  };
}
