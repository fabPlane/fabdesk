import { CART_ITEM_STATUSES, type CartItem, type CartItemPatch, type CartItemStatus, type Destination } from "@fabdesk/protocol";
import { useEffect, useMemo, useState, type InputHTMLAttributes } from "react";
import { Badge, Button, EmptyState, IconButton, Input, Select, Spinner } from "../components/ui";
import {
  cloudErrorMessage,
  destinationOptions,
  groupByDestination,
  isCloudSignedOut,
  itemLabel,
  useCloudDestinations,
  useCloudStatus,
  useCore,
  useShoppingList,
  useShoppingListMutations,
} from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { cn } from "../util";

/** Text/number input that reports its value on blur or Enter, only when it changed. */
function CommitInput({
  value,
  onCommit,
  className,
  ...rest
}: { value: string; onCommit: (v: string) => void } & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange">) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  return (
    <Input
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") setDraft(value);
      }}
      className={cn("h-6 px-1.5 text-xs", className)}
    />
  );
}

const STATUS_TONE: Record<CartItemStatus, "neutral" | "accent" | "success"> = {
  needed: "neutral",
  ordered: "accent",
  received: "success",
};

function SignedOut() {
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  return (
    <EmptyState
      title="Sign in to fabplane"
      action={
        <Button variant="primary" size="sm" onClick={() => setSettingsOpen(true, "auth")}>
          Open Account settings
        </Button>
      }
    >
      Shopping lists live on fabplane.com so your team can see and order them.
    </EmptyState>
  );
}

function DestinationSelect({
  value,
  options,
  onChange,
  className,
}: {
  value: string;
  options: Destination[];
  onChange: (id: string) => void;
  className?: string;
}) {
  const known = options.some((d) => d.id === value);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className={cn("h-6 px-1 text-xs", className)}>
      {!known && value && <option value={value}>{value}</option>}
      {options.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </Select>
  );
}

function ItemRow({
  item,
  options,
  onPatch,
  onRemove,
}: {
  item: CartItem;
  options: Destination[];
  onPatch: (patch: CartItemPatch) => void;
  onRemove: () => void;
}) {
  const sub = [item.mpn && item.value ? item.value : null, item.footprint, item.manufacturer].filter(Boolean).join(" · ");
  return (
    <tr className="border-t border-border/60 align-middle hover:bg-panel-2/40" data-testid={`shopping-item-${item.id}`}>
      <td className="px-2 py-1">
        <div className="flex items-center gap-1.5">
          {item.kind !== "part" && <Badge tone="warning">{item.kind}</Badge>}
          <span className="truncate font-medium" title={item.description ?? undefined}>
            {itemLabel(item)}
          </span>
        </div>
        {sub && <div className="truncate font-mono text-[10.5px] text-muted">{sub}</div>}
        {item.sku && <div className="truncate font-mono text-[10.5px] text-muted">SKU {item.sku}</div>}
      </td>
      <td className="max-w-[140px] px-2 py-1 font-mono text-[11px] text-muted" title={(item.refs ?? []).join(" ")}>
        <div className="truncate">{(item.refs ?? []).join(" ")}</div>
      </td>
      <td className="w-16 px-1 py-1">
        <CommitInput
          type="number"
          min={0}
          value={String(item.quantity)}
          onCommit={(v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n >= 0) onPatch({ quantity: n });
          }}
          aria-label="Quantity"
        />
      </td>
      <td className="w-36 px-1 py-1">
        <DestinationSelect value={item.destinationId} options={options} onChange={(destinationId) => onPatch({ destinationId })} className="w-full" />
      </td>
      <td className="w-24 px-1 py-1">
        <Select
          value={item.status}
          onChange={(e) => onPatch({ status: e.target.value as CartItemStatus })}
          className="h-6 w-full px-1 text-xs"
          aria-label="Status"
        >
          {CART_ITEM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </td>
      <td className="px-1 py-1">
        <CommitInput value={item.notes ?? ""} placeholder="Notes" onCommit={(notes) => onPatch({ notes })} />
      </td>
      <td className="w-8 px-1 py-1 text-right">
        <IconButton title="Remove" className="h-6 w-6 text-muted hover:text-danger" onClick={onRemove}>
          &#10005;
        </IconButton>
      </td>
    </tr>
  );
}

function AddRow({ options, fab, onAdd, busy }: { options: Destination[]; fab: string; onAdd: (item: { label: string; quantity: number; destinationId: string }) => void; busy: boolean }) {
  const [label, setLabel] = useState("");
  const [qty, setQty] = useState("1");
  const [dest, setDest] = useState(fab);
  useEffect(() => setDest(fab), [fab]);
  const n = Number(qty);
  const valid = label.trim() !== "" && Number.isInteger(n) && n >= 0;
  return (
    <form
      className="flex items-center gap-1.5 border-t border-border px-2 py-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onAdd({ label: label.trim(), quantity: n, destinationId: dest });
        setLabel("");
        setQty("1");
      }}
    >
      <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add item: MPN or description" className="h-7 min-w-0 flex-1 text-xs" data-testid="shopping-add-label" />
      <Input type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} className="h-7 w-16 text-xs" aria-label="Quantity" />
      <DestinationSelect value={dest} options={options} onChange={setDest} className="h-7 w-36" />
      <Button type="submit" size="sm" disabled={!valid || busy}>
        Add
      </Button>
    </form>
  );
}

/** Looks like an MPN: one token with digits and no spaces. */
const looksLikeMpn = (s: string) => !/\s/.test(s) && /\d/.test(s) && s.length <= 60;

export function ShoppingListTab() {
  const { host } = useCore();
  const projectId = useUiStore((s) => s.activeProjectId);
  const status = useCloudStatus();
  const ready = !!status.data?.available && !!status.data.signedIn;
  const list = useShoppingList(projectId, ready);
  const destinations = useCloudDestinations(ready);
  const m = useShoppingListMutations(projectId);
  const [notice, setNotice] = useState<string | null>(null);
  const options = useMemo(() => destinationOptions(destinations.data ?? []), [destinations.data]);
  const cart = list.data?.cart ?? null;
  const groups = useMemo(() => groupByDestination(cart?.items ?? [], destinations.data ?? []), [cart, destinations.data]);

  if (!projectId) return <EmptyState title="No project selected" />;
  if (status.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (status.data && !status.data.available)
    return <EmptyState title="Shopping lists unavailable">This build of fabPlane has no fabplane.com client.</EmptyState>;
  if (!ready || isCloudSignedOut(list.error)) return <SignedOut />;
  if (list.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const pending = m.create.isPending || m.syncBom.isPending;
  const mutationError = [m.create, m.syncBom, m.add, m.update, m.remove].find((x) => x.isError)?.error;
  const error = list.error ?? mutationError;

  const syncBom = () =>
    m.syncBom.mutate(undefined, {
      onSuccess: ({ summary: s }) =>
        setNotice(`Synced ${s.parts} part lines: ${s.added} new, ${s.removed} removed, ${s.matched} kept their edits${s.pcbAdded ? ", PCB line added" : ""}.`),
    });

  if (!cart) {
    return (
      <EmptyState
        title="No shopping list yet"
        action={
          <div className="flex gap-2">
            <Button size="sm" onClick={() => m.create.mutate()} disabled={pending}>
              Create shopping list
            </Button>
            <Button variant="primary" size="sm" onClick={syncBom} disabled={pending} data-testid="shopping-sync-bom">
              {m.syncBom.isPending ? "Syncing..." : "Sync from BOM"}
            </Button>
          </div>
        }
      >
        A fabplane.com cart for this project, grouped by where each part is bought.
        {error && <div className="mt-2 text-danger">{cloudErrorMessage(error)}</div>}
      </EmptyState>
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="shopping-list">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <span className="truncate text-[13px] font-medium">{cart.name}</span>
        <span className="text-[11px] text-muted">
          {cart.items.length} line{cart.items.length === 1 ? "" : "s"}
        </span>
        {cart.repos.map((r) => (
          <Badge key={r} title={r} className="max-w-[200px] truncate font-mono">
            {r.replace(/^https?:\/\//, "").replace(/\.git$/, "")}
          </Badge>
        ))}
        <div className="ml-auto flex items-center gap-1.5">
          {list.isFetching && <Spinner />}
          <Button size="sm" onClick={syncBom} disabled={pending} data-testid="shopping-sync-bom">
            {m.syncBom.isPending ? "Syncing..." : "Sync from BOM"}
          </Button>
          {list.data?.cartUrl && (
            <Button size="sm" variant="ghost" onClick={() => void host.openExternal(list.data!.cartUrl!)}>
              Open in dashboard &#8599;
            </Button>
          )}
        </div>
      </div>
      {(notice || error) && (
        <div className={cn("border-b border-border px-2 py-1 text-xs", error ? "text-danger" : "text-muted")}>
          {error ? cloudErrorMessage(error) : notice}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {groups.length === 0 && <div className="px-3 py-6 text-center text-xs text-muted">The list is empty. Sync from the BOM or add items below.</div>}
        {groups.map((g) => (
          <section key={g.destinationId} className="mb-1">
            <div className="sticky top-0 z-10 flex items-center gap-2 bg-panel px-2 pb-1 pt-2">
              <span className="text-[10.5px] font-semibold uppercase tracking-wide">{g.name}</span>
              <span className="text-[10.5px] text-muted">
                {g.items.length} line{g.items.length === 1 ? "" : "s"} · {g.totalQuantity} pcs
              </span>
              {g.url && (
                <button type="button" className="ml-auto text-[11px] text-accent hover:underline" onClick={() => void host.openExternal(g.url!)}>
                  {g.url.replace(/^https?:\/\/(www\.)?/, "")}
                </button>
              )}
            </div>
            <table className="w-full table-fixed text-left text-xs">
              <colgroup>
                <col />
                <col className="w-[18%]" />
                <col className="w-16" />
                <col className="w-36" />
                <col className="w-24" />
                <col className="w-[18%]" />
                <col className="w-8" />
              </colgroup>
              <tbody>
                {g.items.map((item) => (
                  <ItemRow
                    key={item.id}
                    item={item}
                    options={options}
                    onPatch={(patch) => m.update.mutate({ itemId: item.id, patch })}
                    onRemove={() => m.remove.mutate(item.id)}
                  />
                ))}
              </tbody>
            </table>
          </section>
        ))}
        {groups.length > 0 && (
          <div className="px-2 py-1 text-[11px] text-muted">
            Status: {CART_ITEM_STATUSES.map((s) => (
              <Badge key={s} tone={STATUS_TONE[s]} className="mr-1">
                {s}: {cart.items.filter((i) => i.status === s).length}
              </Badge>
            ))}
          </div>
        )}
      </div>
      <AddRow
        options={options}
        fab={cart.fabDestinationId}
        busy={m.add.isPending}
        onAdd={({ label, quantity, destinationId }) =>
          m.add.mutate([
            {
              kind: "part",
              quantity,
              destinationId,
              ...(looksLikeMpn(label) ? { mpn: label } : { description: label }),
            },
          ])
        }
      />
    </div>
  );
}
