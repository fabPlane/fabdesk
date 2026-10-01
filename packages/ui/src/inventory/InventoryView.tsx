import type { InventoryItem } from "@fabdesk/protocol";
import { useEffect, useState } from "react";
import { Badge, Button, EmptyState, IconButton, Input, Spinner } from "../components/ui";
import {
  cloudErrorMessage,
  isCloudSignedOut,
  useCloudStatus,
  useCore,
  useInventory,
  useInventoryMutations,
} from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { Icon } from "../components/Icon";

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/heic,image/heif";

function AddItemForm({ onDone }: { onDone: () => void }) {
  const { create } = useInventoryMutations();
  const [name, setName] = useState("");
  const [mpn, setMpn] = useState("");
  const [qty, setQty] = useState("1");
  const [location, setLocation] = useState("");
  const [tags, setTags] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const n = Number(qty);
  const valid = name.trim() !== "" && Number.isInteger(n) && n >= 0;
  return (
    <form
      className="grid grid-cols-2 gap-2 border-b border-border bg-panel-2/40 px-4 py-3 text-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
        create.mutate(
          {
            input: {
              name: name.trim(),
              quantity: n,
              source: "fabdesk",
              ...(mpn.trim() ? { mpn: mpn.trim() } : {}),
              ...(location.trim() ? { location: location.trim() } : {}),
              ...(tagList.length ? { tags: tagList } : {}),
            },
            ...(image ? { image: { data: image, filename: image.name } } : {}),
          },
          { onSuccess: onDone },
        );
      }}
      data-testid="inventory-add-form"
    >
      <Input autoFocus placeholder="Name *" value={name} onChange={(e) => setName(e.target.value)} className="h-7 text-xs" />
      <Input placeholder="MPN" value={mpn} onChange={(e) => setMpn(e.target.value)} className="h-7 text-xs" />
      <Input type="number" min={0} placeholder="Quantity" value={qty} onChange={(e) => setQty(e.target.value)} className="h-7 text-xs" />
      <Input placeholder="Location (e.g. lab / drawer A3)" value={location} onChange={(e) => setLocation(e.target.value)} className="h-7 text-xs" />
      <Input placeholder="Tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} className="h-7 text-xs" />
      <label className="flex items-center gap-2 text-muted">
        <span>Photo</span>
        <input type="file" accept={IMAGE_ACCEPT} onChange={(e) => setImage(e.target.files?.[0] ?? null)} className="min-w-0 text-[11px]" />
      </label>
      <div className="col-span-2 flex items-center justify-end gap-2">
        {create.isError && <span className="mr-auto text-danger">{cloudErrorMessage(create.error)}</span>}
        <Button size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={!valid || create.isPending}>
          {create.isPending ? "Adding..." : "Add item"}
        </Button>
      </div>
    </form>
  );
}

function InventoryRow({ item }: { item: InventoryItem }) {
  const { adjust } = useInventoryMutations();
  const thumb = item.images[0]?.url;
  const busy = adjust.isPending;
  return (
    <tr className="border-t border-border/60 align-middle hover:bg-panel-2/40" data-testid={`inventory-item-${item.id}`}>
      <td className="w-12 px-2 py-1.5">
        {thumb ? (
          <img src={thumb} alt="" className="h-9 w-9 rounded border border-border object-cover" loading="lazy" />
        ) : (
          <div className="h-9 w-9 rounded border border-dashed border-border" />
        )}
      </td>
      <td className="px-2 py-1.5">
        <div className="truncate font-medium" title={item.name}>{item.name}</div>
        <div className="truncate font-mono text-[10.5px] text-muted">
          {[item.mpn, item.manufacturer, item.category].filter(Boolean).join(" · ")}
        </div>
      </td>
      <td className="w-36 px-2 py-1.5">
        <div className="flex items-center gap-1">
          <IconButton title="Use one" size="xs" disabled={busy || item.quantity <= 0} onClick={() => adjust.mutate({ itemId: item.id, delta: -1 })}>
            <Icon name="minus" width={16} height={16} />
          </IconButton>
          <span className="min-w-[3ch] text-center font-mono">{item.quantity}</span>
          <IconButton title="Add one" size="xs" disabled={busy} onClick={() => adjust.mutate({ itemId: item.id, delta: 1 })}>
            <Icon name="plus" width={16} height={16} />
          </IconButton>
          <span className="text-[10.5px] text-muted">{item.unit}</span>
        </div>
      </td>
      <td className="px-2 py-1.5 text-muted">{item.location ?? ""}</td>
      <td className="px-2 py-1.5">
        <div className="flex flex-wrap gap-1">
          {item.tags.map((t) => (
            <Badge key={t}>{t}</Badge>
          ))}
        </div>
      </td>
    </tr>
  );
}

/** Center pane for the sidebar's Inventory tab: the active fabplane org's parts on hand. */
export function InventoryView() {
  const { host } = useCore();
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setInventoryOpen = useUiStore((s) => s.setInventoryOpen);
  const status = useCloudStatus();
  const ready = !!status.data?.available && !!status.data.signedIn;
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim(), 250);
  const inventory = useInventory(query, ready);
  const [adding, setAdding] = useState(false);
  const org = status.data?.orgs.find((o) => o.id === status.data?.activeOrgId);

  if (status.isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  if (status.data && !status.data.available)
    return <EmptyState title="Inventory unavailable">This build of fabPlane has no fabplane.com client.</EmptyState>;
  if (!ready || isCloudSignedOut(inventory.error))
    return (
      <EmptyState
        title="Sign in to fabplane"
        action={
          <Button variant="primary" size="sm" onClick={() => setSettingsOpen(true, "auth")}>
            Open Account settings
          </Button>
        }
      >
        The team inventory lives on fabplane.com.
      </EmptyState>
    );

  const items = inventory.data?.items ?? [];
  return (
    <div className="fd-content-pane flex h-full min-w-0 flex-col bg-bg" data-testid="inventory-view">
      <div className="fd-screen-header flex flex-wrap items-center gap-2 border-b border-border px-4">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">Parts Inventory</div>
          {org && <div className="truncate text-[11px] text-muted">{org.name}</div>}
        </div>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, MPN, SKU..." aria-label="Search inventory" className="ml-auto h-8 max-w-xs flex-1 basis-40 text-xs" data-testid="inventory-search" />
        {inventory.isFetching && <Spinner />}
        <Button size="sm" variant="primary" onClick={() => setAdding((v) => !v)}>
          Add item
        </Button>
        {status.data?.dashboardUrl && (
          <Button size="sm" variant="ghost" onClick={() => void host.openExternal(`${status.data!.dashboardUrl}/inventory`)}>
            Dashboard &#8599;
          </Button>
        )}
        <IconButton title="Close Parts Inventory" onClick={() => setInventoryOpen(false)} data-testid="inventory-close">
          <Icon name="close" />
        </IconButton>
      </div>
      {adding && <AddItemForm onDone={() => setAdding(false)} />}
      {inventory.error && <div className="border-b border-border px-4 py-1.5 text-xs text-danger">{cloudErrorMessage(inventory.error)}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {inventory.isLoading && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {!inventory.isLoading && items.length === 0 && (
          <div className="px-4 py-8 text-center text-xs text-muted">
            {query ? `Nothing matches "${query}".` : "No inventory yet. Add parts here, or ask the agent to use inventory_add."}
          </div>
        )}
        {items.length > 0 && (
          <table className="w-full min-w-[640px] table-fixed text-left text-xs">
            <colgroup><col className="w-12" /><col /><col className="w-36" /><col className="w-32" /><col className="w-32" /></colgroup>
            <thead className="sticky top-0 bg-panel">
              <tr className="text-[10.5px] uppercase tracking-wide text-muted">
                <th className="px-2 py-1.5" />
                <th className="px-2 py-1.5">Item</th>
                <th className="px-2 py-1.5">Qty</th>
                <th className="px-2 py-1.5">Location</th>
                <th className="px-2 py-1.5">Tags</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <InventoryRow key={item.id} item={item} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
