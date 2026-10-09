import { CART_ITEM_STATUSES, type CartItem, type CartItemPatch, type CartItemStatus, type Destination } from "@fabdesk/protocol";
import { useEffect, useMemo, useState, type CSSProperties, type InputHTMLAttributes } from "react";
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
import { Icon } from "../components/Icon";
import { ProjectBomPanel } from "./ProjectBomPanel";

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
      className={cn("px-1.5", className)}
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
  style,
}: {
  value: string;
  options: Destination[];
  onChange: (id: string) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const known = options.some((d) => d.id === value);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className={cn("px-1", className)} style={style} aria-label="Destination">
      {!known && value && <option value={value}>{value}</option>}
      {options.map((d) => (
        <option key={d.id} value={d.id}>
          {d.name}
        </option>
      ))}
    </Select>
  );
}

/** `cn` does not merge Tailwind classes, so compact control sizes go in inline styles. */
const COMPACT = { height: 32, fontSize: 12 } as const;

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
  const refs = (item.refs ?? []).join(" ");
  return (
    <div className="border-t border-border/60 px-2 py-1.5 hover:bg-panel-2/40" data-testid={`shopping-item-${item.id}`}>
      <div className="flex min-w-0 items-center gap-1.5">
        {item.kind !== "part" && <Badge tone="warning">{item.kind}</Badge>}
        <span className="min-w-0 truncate text-xs font-medium" title={item.description ?? itemLabel(item)}>
          {itemLabel(item)}
        </span>
        {refs && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted" title={refs}>
            {refs}
          </span>
        )}
        <IconButton title="Remove" size="xs" className="ml-auto shrink-0 text-muted hover:text-danger" onClick={onRemove}>
          <Icon name="close" width={16} height={16} />
        </IconButton>
      </div>
      {(sub || item.sku) && (
        <div className="truncate font-mono text-[10.5px] text-muted" title={sub}>
          {[sub, item.sku ? `SKU ${item.sku}` : null].filter(Boolean).join(" · ")}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <CommitInput
          type="number"
          min={0}
          value={String(item.quantity)}
          onCommit={(v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n >= 0) onPatch({ quantity: n });
          }}
          aria-label="Quantity"
          style={{ ...COMPACT, width: 60, flex: "none" }}
        />
        <DestinationSelect
          value={item.destinationId}
          options={options}
          onChange={(destinationId) => onPatch({ destinationId })}
          style={{ ...COMPACT, minWidth: 0, flex: "1 1 120px" }}
        />
        <Select
          value={item.status}
          onChange={(e) => onPatch({ status: e.target.value as CartItemStatus })}
          className="px-1"
          style={{ ...COMPACT, width: 92, flex: "none" }}
          aria-label="Status"
        >
          {CART_ITEM_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <CommitInput
          value={item.notes ?? ""}
          placeholder="Notes"
          onCommit={(notes) => onPatch({ notes })}
          style={{ ...COMPACT, minWidth: 0, flex: "1 1 120px" }}
        />
      </div>
    </div>
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
      className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-3 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        onAdd({ label: label.trim(), quantity: n, destinationId: dest });
        setLabel("");
        setQty("1");
      }}
    >
      <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Add item: MPN or description" aria-label="Item description or MPN" className="text-xs" style={{ height: 32, minWidth: 0, flex: "1 1 180px" }} data-testid="shopping-add-label" />
      <Input type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} className="text-xs" style={{ ...COMPACT, width: 60, flex: "none" }} aria-label="Quantity" />
      <DestinationSelect value={dest} options={options} onChange={setDest} className="text-xs" style={{ ...COMPACT, width: 140, flex: "none" }} />
      <Button type="submit" size="sm" disabled={!valid || busy}>
        Add
      </Button>
    </form>
  );
}

/** Looks like an MPN: one token with digits and no spaces. */
const looksLikeMpn = (s: string) => !/\s/.test(s) && /\d/.test(s) && s.length <= 60;

export function ShoppingListTab() {
  const [view, setView] = useState<"bom" | "order">("bom");
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="bom-tab">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <Button size="sm" variant={view === "bom" ? "secondary" : "ghost"} onClick={() => setView("bom")} data-testid="bom-view-project">
          Project BOM
        </Button>
        <Button size="sm" variant={view === "order" ? "secondary" : "ghost"} onClick={() => setView("order")} data-testid="bom-view-shopping">
          Shopping list
        </Button>
      </div>
      <div className="min-h-0 flex-1">{view === "bom" ? <ProjectBomPanel /> : <ShoppingListCloud />}</div>
    </div>
  );
}

function ShoppingListCloud() {
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
          <div className="flex flex-wrap justify-center gap-2">
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
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
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
            <div>
              {g.items.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                options={options}
                onPatch={(patch) => m.update.mutate({ itemId: item.id, patch })}
                onRemove={() => m.remove.mutate(item.id)}
              />
            ))}
            </div>
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
