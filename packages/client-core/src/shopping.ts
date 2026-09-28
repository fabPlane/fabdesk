/** Pure helpers for the shopping list and inventory views. */
import {
  BUILTIN_DESTINATIONS,
  type CartItem,
  type Destination,
} from "@fabdesk/protocol";
import { CoreHttpError } from "./CoreClient";

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
  return e instanceof CoreHttpError && e.status === 401 && e.message.includes("cloud_signed_out");
}

/** A readable message from a core error body (`{ error, message }`) or any Error. */
export function cloudErrorMessage(e: unknown): string {
  if (e instanceof CoreHttpError) {
    try {
      const body = JSON.parse(e.message) as { error?: string; message?: string };
      return body.message ?? body.error ?? e.message;
    } catch {
      return e.message;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
