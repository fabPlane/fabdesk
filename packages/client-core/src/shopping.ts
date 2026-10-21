/** Pure helpers for the shopping list and inventory views. */
import {
  BUILTIN_DESTINATIONS,
  type CartItem,
  type CartItemPatch,
  type CartItemStatus,
  type Destination,
} from "@fabdesk/protocol";
import { CoreHttpError } from "./CoreClient";

type EditableItem = Pick<CartItem, "quantity" | "destinationId" | "status" | "notes">;
export type ShoppingItemDraft = {
  base: EditableItem;
  quantity: string;
  destinationId: string;
  status: CartItemStatus;
  notes: string;
};

export function createShoppingDraft(item: EditableItem): ShoppingItemDraft {
  return { base: { ...item }, quantity: String(item.quantity), destinationId: item.destinationId, status: item.status, notes: item.notes ?? "" };
}

/** Patch only fields the user changed, leaving team/agent updates alone. */
export function shoppingDraftPatch(draft: ShoppingItemDraft): CartItemPatch {
  const patch: CartItemPatch = {};
  if (Number(draft.quantity) !== draft.base.quantity) patch.quantity = Number(draft.quantity);
  if (draft.destinationId !== draft.base.destinationId) patch.destinationId = draft.destinationId;
  if (draft.status !== draft.base.status) patch.status = draft.status;
  if (draft.notes !== (draft.base.notes ?? "")) patch.notes = draft.notes;
  return patch;
}

export function rebaseShoppingDraft(draft: ShoppingItemDraft, current: EditableItem): ShoppingItemDraft {
  const patch = shoppingDraftPatch(draft);
  return {
    base: { ...current },
    quantity: "quantity" in patch ? draft.quantity : String(current.quantity),
    destinationId: patch.destinationId ?? current.destinationId,
    status: patch.status ?? current.status,
    notes: patch.notes ?? current.notes ?? "",
  };
}

/** Detect overlapping edits seen by polling; the API does not support atomic revisions. */
export function shoppingDraftConflicts(draft: ShoppingItemDraft, current: EditableItem): string[] {
  const patch = shoppingDraftPatch(draft);
  const labels = { quantity: "quantity", destinationId: "supplier", status: "order status", notes: "notes" } as const;
  return (Object.keys(labels) as (keyof EditableItem)[]).filter(key =>
    key in patch && (current[key] ?? "") !== (draft.base[key] ?? "") && (current[key] ?? "") !== patch[key],
  ).map(key => labels[key]);
}

export type DestinationGroup = {
  destinationId: string;
  name: string;
  kind: Destination["kind"] | "unknown";
  url: string | null;
  items: CartItem[];
  totalQuantity: number;
};

const KIND_ORDER: Record<DestinationGroup["kind"], number> = { fab: 0, distributor: 1, manual: 2, unknown: 3 };

/**
 * Items grouped by purchase destination: fab houses first, then distributors, manual purchase,
 * and ids the destination list does not know; PCB lines lead their group, then parts by first ref.
 */
export function groupByDestination(
  items: readonly CartItem[],
  destinations: readonly Destination[] = [],
): DestinationGroup[] {
  const known = [...destinations, ...BUILTIN_DESTINATIONS];
  const groups = new Map<string, DestinationGroup>();
  for (const item of items) {
    let g = groups.get(item.destinationId);
    if (!g) {
      const d = known.find((x) => x.id === item.destinationId);
      g = {
        destinationId: item.destinationId,
        name: d?.name ?? item.destinationId,
        kind: d?.kind ?? "unknown",
        url: d?.url ?? null,
        items: [],
        totalQuantity: 0,
      };
      groups.set(item.destinationId, g);
    }
    g.items.push(item);
    g.totalQuantity += item.quantity;
  }
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const rank = (i: CartItem) => (i.kind === "pcb" ? 0 : i.kind === "part" ? 1 : 2);
  for (const g of groups.values())
    g.items.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        collator.compare(a.refs?.[0] ?? "~", b.refs?.[0] ?? "~") ||
        collator.compare(itemLabel(a), itemLabel(b)),
    );
  return [...groups.values()].sort(
    (a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
  );
}

/** What to call a line: MPN, else value (+ footprint), else description. */
export function itemLabel(item: Pick<CartItem, "mpn" | "value" | "description" | "kind">): string {
  return item.mpn || item.value || item.description || item.kind;
}

/** Search both visible labels and the details tucked into the item editor. */
export function filterShoppingItems(items: readonly CartItem[], query: string, status: CartItemStatus | "all", destinations: readonly Destination[] = []): CartItem[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const names = new Map([...BUILTIN_DESTINATIONS, ...destinations].map(d => [d.id, d.name]));
  return items.filter(item => {
    if (status !== "all" && item.status !== status) return false;
    const text = [itemLabel(item), item.value, item.description, item.mpn, item.manufacturer, item.footprint, item.sku, item.notes, ...(item.refs ?? []), names.get(item.destinationId)]
      .filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every(term => text.includes(term));
  });
}

/** Destinations for a picker: fab houses, distributors, manual, then the org's custom ones. */
export function destinationOptions(destinations: readonly Destination[]): Destination[] {
  const list = destinations.length ? destinations : BUILTIN_DESTINATIONS;
  return [...list].sort(
    (a, b) =>
      Number(!a.builtin) - Number(!b.builtin) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.name.localeCompare(b.name),
  );
}

/** The core answers 401 `cloud_signed_out` when fabplane has no (valid) sign-in. */
export function isCloudSignedOut(e: unknown): boolean {
  return e instanceof CoreHttpError && e.status === 401 && e.code === "cloud_signed_out";
}

/** A readable message from a core error body (`{ error, message }`) or any Error. */
export function cloudErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
