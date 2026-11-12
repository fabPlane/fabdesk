import { cloudAccountId, useAuthStore } from "@fabdesk/client-core";
import { FeedbackNotice } from "../components/FeedbackNotice";
import { useProjectExitGuard } from "../hooks/useProjectExitGuard";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { CART_ITEM_STATUSES, type BomSyncOptions, type CartItem, type CartItemPatch, type CartItemStatus, type Destination } from "@fabdesk/protocol";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Dialog, EmptyState, IconButton, Input, Select, Spinner, Textarea } from "../components/ui";
import {
  cloudErrorMessage, destinationOptions, filterShoppingItems, groupByDestination, isCloudSignedOut,
  createShoppingDraft, shoppingDraftPatch, shoppingDraftConflicts, rebaseShoppingDraft, type ShoppingItemDraft,
  itemLabel, useCloudDestinations, useCloudStatus, useCore, useShoppingList, useShoppingListMutations,
  useProjectBom,
} from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { Icon } from "../components/Icon";
import { ProjectBomPanel } from "./ProjectBomPanel";
import "./shopping-list.css";

function ShoppingBomDialog({ projectId, open, busy, error, onClose, onSync }: { projectId: string; open: boolean; busy: boolean; error: unknown; onClose: () => void; onSync: (options: BomSyncOptions) => void }) {
  const bom = useProjectBom(projectId, open), [allowPartial, setAllowPartial] = useState(false);
  useEffect(() => { setAllowPartial(false); }, [open, bom.data?.revision]);
  const surface = { projectId, label: "Shopping / Review BOM import", priority: 20, details: JSON.stringify({ snapshotRevision: bom.data?.revision, coverage: bom.data?.coverage, importParts: bom.data?.lines.length, partialCoverage: !bom.data?.complete, ordering: "not performed", error: error instanceof Error ? error.message : undefined }) };
  useAssistantSurface(open ? surface : null);
  return <Dialog open={open} closeDisabled={busy} title="Review parts before syncing" onClose={() => { if (!busy) onClose(); }}>
    <div className="space-y-4 text-sm">
      {bom.isLoading || bom.isFetching ? <p className="flex items-center gap-2"><Spinner />Reading saved design sources…</p> : bom.isError ? <div role="alert"><p className="text-danger">{bom.error instanceof Error ? bom.error.message : "Could not read the project BOM."}</p><Button size="sm" onClick={() => void bom.refetch()}>Retry source check</Button></div> : <>
        <p>{bom.data?.lines.length ?? 0} listed items from your Design BOM. Matching suppliers, order status and notes stay saved; manual items are kept.</p>
        <div className="max-h-52 space-y-2 overflow-auto">{bom.data?.coverage.map(source => <div className="rounded-lg border border-border p-3 text-xs" key={source.sourceId ?? "main"}><strong>{source.name}</strong><p className="mt-1 text-muted">{source.status === "native-schematic" ? `${source.multiplier} declared ${source.multiplier === 1 ? "board" : "boards"} · ${source.componentCount * source.multiplier} included parts` : source.reason ?? source.status}</p></div>)}</div>
        {!bom.data?.complete && <label className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3"><input type="checkbox" checked={allowPartial} disabled={busy} onChange={event => setAllowPartial(event.target.checked)} /><span>Sync only the listed parts<span className="mt-1 block text-xs text-muted">Coverage is incomplete or netlist-only. Unmatched saved items will be kept so missing sources cannot remove them.</span></span></label>}
        {bom.data?.manifestSha256 === null && <p className="text-xs text-muted">If the list has no PCB item, an editable fabrication line defaults to 5 boards. Review that quantity in Shopping.</p>}
        {bom.data?.manifestSha256 && <p className="text-xs text-muted">Assembly PCB orders stay separate; this imports component quantities without adding a generic project PCB order.</p>}
      </>}
      {!!error && <p role="alert" className="text-danger">{cloudErrorMessage(error)}</p>}
      <p className="text-xs text-muted">This updates your team’s shopping list. It does not place an order or establish electrical checks.</p>
      <div className="flex flex-wrap items-center justify-end gap-2"><IconButton title="Ask about these BOM sources" onClick={() => askAboutSurface(surface, "Help me review this BOM’s source coverage and quantities before importing it into Shopping. Identify missing sources and preserve existing supplier and order details.")}><Icon name="sparkles" /></IconButton><Button disabled={busy} onClick={() => { onClose(); useUiStore.getState().setBoardTab("bom"); }}>Open Design BOM</Button><Button variant="primary" disabled={busy || bom.isFetching || bom.isError || !bom.data?.lines.length || (!bom.data.complete && !allowPartial)} onClick={() => { if (bom.data) onSync({ expectedRevision: bom.data.revision, allowPartial }); }}>{busy ? "Syncing…" : "Sync shopping list"}</Button></div>
    </div>
  </Dialog>;
}

const STATUS_LABEL: Record<CartItemStatus, string> = { needed: "To order", ordered: "Ordered", received: "Received" };

function SignedOut() {
  const setSettingsOpen = useUiStore(s => s.setSettingsOpen);
  return <EmptyState title="Connect your shopping list" action={<Button onClick={() => setSettingsOpen(true, "auth")}>Sign in to fabPlane</Button>}>
    Keep parts, suppliers, and order progress together with your team.
  </EmptyState>;
}

function DestinationSelect({ value, options, onChange }: { value: string; options: Destination[]; onChange: (id: string) => void }) {
  return <Select value={value} onChange={e => onChange(e.target.value)}>
    {!options.some(d => d.id === value) && <option value={value}>{value || "Choose a supplier"}</option>}
    {options.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
  </Select>;
}

function ItemEditor({ item, draft, onDraft, options, onSave, onRemove, onClose, onBusy }: {
  draft: ShoppingItemDraft; onDraft: (draft: ShoppingItemDraft) => void; onBusy: (busy: boolean) => void;
  item: CartItem; options: Destination[]; onSave: (patch: CartItemPatch) => Promise<unknown>;
  onRemove: () => Promise<unknown>; onClose: () => void;
}) {
  const { quantity, destinationId, status, notes } = draft;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const saving = useRef(false);
  const valid = quantity.trim() !== "" && Number.isSafeInteger(Number(quantity)) && Number(quantity) >= 0;
  const patch = shoppingDraftPatch(draft);
  const changed = quantity.trim() === "" || Object.keys(patch).length > 0;
  const conflicts = shoppingDraftConflicts(draft, item);
  const perform = async (action: () => Promise<unknown>) => {
    if (saving.current) return;
    saving.current = true; setBusy(true); onBusy(true); setError(null);
    try { await action(); onClose(); }
    catch (e) { setError(cloudErrorMessage(e)); }
    finally { saving.current = false; setBusy(false); onBusy(false); }
  };
  return <form className="shopping-editor" aria-busy={busy} onSubmit={e => {
    e.preventDefault();
    if (valid && changed && !confirmRemove && !conflicts.length) void perform(() => onSave(patch));
  }}>
    <fieldset disabled={busy}>
      <div className="shopping-fields">
        <label>Quantity<Input type="number" min={0} step={1} required value={quantity} onChange={e => onDraft({ ...draft, quantity: e.target.value })} /></label>
        <label>Supplier<DestinationSelect value={destinationId} options={options} onChange={value => onDraft({ ...draft, destinationId: value })} /></label>
        <label>Order status<Select value={status} onChange={e => onDraft({ ...draft, status: e.target.value as CartItemStatus })}>
          {CART_ITEM_STATUSES.map(s => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </Select></label>
      </div>
      {!valid && <p className="shopping-error" role="status">Enter a whole quantity of 0 or more.</p>}
      <label className="shopping-notes">Notes <span className="shopping-optional">Optional</span>
        <Textarea rows={2} maxLength={4000} value={notes} onChange={e => onDraft({ ...draft, notes: e.target.value })} placeholder="Alternatives, delivery details, or a note for your team…" />
      </label>
      <dl className="shopping-specs">
        <dt>Item</dt><dd>{itemLabel(item)}</dd>
        <dt>Type</dt><dd>{item.kind === "pcb" ? "Printed circuit board" : item.kind === "other" ? "Other item" : "Component"}</dd>
        {item.mpn && item.value && <><dt>Value</dt><dd>{item.value}</dd></>}
        {item.description && item.description !== itemLabel(item) && <><dt>Description</dt><dd>{item.description}</dd></>}
        {!!item.refs?.length && <><dt>References</dt><dd>{item.refs.join(", ")}</dd></>}
        {item.footprint && <><dt>Footprint</dt><dd>{item.footprint}</dd></>}
        {item.manufacturer && <><dt>Manufacturer</dt><dd>{item.manufacturer}</dd></>}
        {item.sku && <><dt>SKU</dt><dd>{item.sku}</dd></>}
      </dl>
      {conflicts.length > 0 && <div role="alert" className="shopping-conflict">Someone updated this item’s {conflicts.join(", ")} while you were editing. Your draft is still here. Review the latest values before saving.<Button size="sm" variant="ghost" onClick={() => onDraft(rebaseShoppingDraft(draft, item))}>Keep my changes</Button><Button size="sm" variant="ghost" onClick={() => onDraft(createShoppingDraft(item))}>Use latest values</Button><p>Latest: {conflicts.map(field => field === "quantity" ? `quantity ${item.quantity}` : field === "supplier" ? `supplier ${options.find(d => d.id === item.destinationId)?.name ?? item.destinationId}` : field === "order status" ? `status ${STATUS_LABEL[item.status]}` : `notes: ${item.notes || "None"}`).join(" · ")}</p></div>}
      {error && <p role="alert" className="shopping-error">{error}</p>}
      <div className="shopping-editor-actions">
        {confirmRemove ? <div className="shopping-remove-confirm"><span>Remove this item?</span><Button size="sm" variant="danger" onClick={() => void perform(onRemove)}>Remove</Button><Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Keep item</Button></div>
          : <Button size="sm" variant="ghost" className="shopping-remove" onClick={() => setConfirmRemove(true)}>Remove item</Button>}
        <div className="shopping-save-actions"><Button size="sm" variant="ghost" onClick={onClose}>{changed ? "Discard changes" : "Cancel"}</Button><Button type="submit" size="sm" variant="primary" disabled={!valid || !changed || confirmRemove || !!conflicts.length}>{busy ? <><Spinner /> Saving…</> : "Save changes"}</Button></div>
      </div>
    </fieldset>
  </form>;
}

export function ShoppingItemRow({ item, options, onPatch, onRemove, draftState }: {
  item: CartItem; options: Destination[]; onPatch: (patch: CartItemPatch) => Promise<unknown>; onRemove: () => Promise<unknown>;
  draftState?: { value: ShoppingItemDraft | undefined; set: (value: ShoppingItemDraft | undefined) => void };
}) {
  const [expanded, setExpanded] = useState(!!draftState?.value);
  const [localDraft, setLocalDraft] = useState<ShoppingItemDraft>();
  const [busy, setBusy] = useState(false);
  const draft = draftState ? draftState.value : localDraft;
  const [quickError, setQuickError] = useState<string | null>(null);
  const setDraft = draftState ? draftState.set : setLocalDraft;
  const dirty = !!draft && (draft.quantity.trim() === "" || Object.keys(shoppingDraftPatch(draft)).length > 0);
  const detailsId = useId();
  const button = useRef<HTMLButtonElement>(null);
  const label = itemLabel(item);
  const subtitle = [item.kind === "pcb" ? "PCB" : item.kind === "other" ? "Other item" : null, item.refs?.join(", "), item.mpn && item.value ? item.value : null, item.footprint, item.manufacturer, item.sku ? `SKU ${item.sku}` : null, item.notes ? "Has notes" : null].filter(Boolean).join(" · ");
  return <li className="shopping-item" data-expanded={expanded} data-testid={`shopping-item-${item.id}`}>
    <div className="shopping-item-line">
    <button ref={button} type="button" className="shopping-item-summary" disabled={busy} aria-expanded={expanded} aria-controls={detailsId} aria-label={`${expanded ? "Collapse" : "Edit"} ${label}, ${subtitle}, quantity ${item.quantity}, ${STATUS_LABEL[item.status]}${dirty ? ", unsaved changes" : ""}`} onClick={() => {
      const selection = window.getSelection();
      if (selection?.toString() && button.current?.contains(selection.anchorNode)) return;
      if (!draft) setDraft(createShoppingDraft(item));
      setExpanded(!expanded);
      if (!expanded) requestAnimationFrame(() => document.getElementById(detailsId)?.querySelector<HTMLInputElement>("input")?.focus());
    }}>
      <span className="shopping-item-identity"><span className="shopping-item-icon"><Icon name={item.kind === "pcb" ? "pcb" : "library"} width={17} height={17} /></span>
        <span className="shopping-item-copy"><span className="shopping-item-name" title={item.description || label}>{label}</span><span className="shopping-item-subtitle" title={subtitle}>{dirty ? "Unsaved changes · " : ""}{subtitle}</span></span>
      </span>
      <span className="shopping-quantity" aria-label={`Quantity ${item.quantity}`}>{item.quantity}</span>
      <span aria-hidden="true" />
      <Icon name="chevronRight" className="shopping-expand" width={15} height={15} />
    </button>
    <Select className="shopping-status shopping-quick-status" data-status={item.status} aria-label={`Order status for ${label}`} title={dirty ? "Save or discard your draft before changing status here" : "Change order status"} value={item.status} disabled={busy || dirty} onChange={async e => {
      const nextStatus = e.target.value as CartItemStatus;
      setBusy(true); setQuickError(null);
      try { await onPatch({ status: nextStatus }); if (draft) { setDraft(undefined); setExpanded(false); } }
      catch (error) { setQuickError(cloudErrorMessage(error)); }
      finally { setBusy(false); }
    }}>{CART_ITEM_STATUSES.map(status => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}</Select>
    </div>
    {quickError && <p role="alert" className="shopping-error shopping-quick-error">{quickError} Choose the status again to retry.</p>}
    <div id={detailsId} className="shopping-disclosure" hidden={!expanded} inert={!expanded}>{draft && <ItemEditor item={item} draft={draft} onDraft={setDraft} onBusy={setBusy} options={options} onSave={onPatch} onRemove={onRemove} onClose={() => { setDraft(undefined); setExpanded(false); button.current?.focus(); }} />}</div>
  </li>;
}

type NewItem = { label: string; quantity: number; destinationId: string };
export function ShoppingAddItem({ options, fab, onAdd, onClose }: { options: Destination[]; fab: string; onAdd: (item: NewItem) => Promise<unknown>; onClose: () => void }) {
  const [label, setLabel] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [destinationId, setDestination] = useState(fab);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const labelInput = useRef<HTMLInputElement>(null);
  const valid = !!label.trim() && quantity.trim() !== "" && Number.isSafeInteger(Number(quantity)) && Number(quantity) >= 0 && !!destinationId;
  return <form className="shopping-add-form" onSubmit={async e => {
    e.preventDefault();
    if (!valid || saving.current) return;
    saving.current = true; setBusy(true); setError(null);
    try { await onAdd({ label: label.trim(), quantity: Number(quantity), destinationId }); setLabel(""); setQuantity("1"); }
    catch (e) { setError(cloudErrorMessage(e)); }
    finally { saving.current = false; setBusy(false); requestAnimationFrame(() => labelInput.current?.focus()); }
  }}>
    <fieldset disabled={busy}>
      <div className="shopping-add-heading"><strong>Add an item</strong><IconButton title="Cancel adding item" size="sm" onClick={onClose}><Icon name="close" /></IconButton></div>
      <label>Part number or description<Input ref={labelInput} autoFocus required maxLength={2000} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. USB-C connector" data-testid="shopping-add-label" /></label>
      <div className="shopping-add-fields"><label>Quantity<Input type="number" min={0} step={1} required value={quantity} onChange={e => setQuantity(e.target.value)} /></label><label>Supplier<DestinationSelect value={destinationId} options={options} onChange={setDestination} /></label></div>
      {(quantity.trim() === "" || !Number.isSafeInteger(Number(quantity)) || Number(quantity) < 0) && <p className="shopping-error" role="status">Enter a whole quantity of 0 or more.</p>}
      {label.length > 0 && !label.trim() && <p className="shopping-error" role="status">Enter a part number or description.</p>}
      {error && <p role="alert" className="shopping-error">{error}</p>}
      <div className="shopping-save-actions"><Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" size="sm" disabled={!valid}>{busy ? <><Spinner /> Adding…</> : "Add item"}</Button></div>
    </fieldset>
  </form>;
}

const looksLikeMpn = (s: string) => !/\s/.test(s) && /\d/.test(s) && s.length <= 60;

export function ShoppingListTab() {
  const account = useAuthStore(s => cloudAccountId(s.state));
  return <ShoppingListTabForAccount key={account ?? "signed-out"} />;
}

function ShoppingListTabForAccount() {
  const [view, setView] = useState<"bom" | "order">("bom");
  const projectId = useUiStore(s => s.activeProjectId);
  useAssistantSurface(projectId ? { projectId, label: view === "bom" ? "Parts / Design BOM" : "Parts / Shopping", priority: 5, details: JSON.stringify({ view, projectId }) } : null);
  const navigation = (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-panel-2/50 p-0.5" role="group" aria-label="Parts view">
      {(["bom", "order"] as const).map((value) => (
        <button key={value} type="button" aria-pressed={view === value} onClick={() => setView(value)}
          data-testid={value === "bom" ? "bom-view-project" : "bom-view-shopping"}
          className={`cursor-pointer rounded-md px-2 py-1 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${view === value ? "bg-panel text-fg shadow-sm" : "text-fg hover:bg-panel-2/70"}`}>
          {value === "bom" ? "Design BOM" : "Shopping"}
        </button>
      ))}
    </div>
  );
  return (
    <div className="fd-parts-workspace flex h-full min-h-0 flex-col" data-testid="bom-tab">
      <div className="shrink-0 border-b border-border px-3 py-1.5">{navigation}</div>
      <div className="min-h-0 flex-1">{view === "bom" ? <ProjectBomPanel key={projectId} /> : <ShoppingListContent key={projectId} />}</div>
    </div>
  );
}

function ShoppingListContent() {
  const { host } = useCore();
  const projectId = useUiStore(s => s.activeProjectId);
  const status = useCloudStatus();
  const ready = !!status.data?.available && !!status.data.signedIn;
  const list = useShoppingList(projectId, ready);
  const destinations = useCloudDestinations(ready);
  const m = useShoppingListMutations(projectId);
  const [notice, setNotice] = useState<string | null>(null);
  const [bomReviewOpen, setBomReviewOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CartItemStatus | "all">("all");
  const [adding, setAdding] = useState(false);
  const [addMounted, setAddMounted] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, ShoppingItemDraft>>({});
  const addButton = useRef<HTMLButtonElement>(null);
  const options = useMemo(() => destinationOptions(destinations.data ?? []), [destinations.data]);
  const cart = list.data?.cart ?? null;
  const filtered = useMemo(() => filterShoppingItems(cart?.items ?? [], query, filter, destinations.data ?? []), [cart, query, filter, destinations.data]);
  const groups = useMemo(() => groupByDestination(filtered, destinations.data ?? []), [filtered, destinations.data]);
  useEffect(() => { setQuery(""); setFilter("all"); setNotice(null); setAdding(false); }, [projectId]);
  const closeAdd = () => { setAdding(false); setAddMounted(false); addButton.current?.focus(); };
  const unsaved = Object.entries(drafts).filter(([id, d]) => cart?.items.some(i => i.id === id) && (d.quantity.trim() === "" || Object.keys(shoppingDraftPatch(d)).length)).length;

  const saving = m.update.isPending || m.remove.isPending || m.add.isPending;
  const pending = m.create.isPending || m.syncBom.isPending || saving;
  useProjectExitGuard(projectId, pending ? "Shopping changes are being saved. Wait for them to finish." : unsaved ? "Save or cancel the unfinished shopping item edits." : addMounted ? "Finish or cancel adding the shopping item." : null);

  if (!projectId) return <EmptyState title="No project selected" />;
  if (status.isLoading || (ready && list.isLoading)) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (status.data && !status.data.available) return <EmptyState title="Shopping lists unavailable">This build of fabPlane has no fabplane.com client.</EmptyState>;
  if (status.isError && !status.data) return <EmptyState title="Couldn’t connect to your shopping list" action={<Button onClick={() => void status.refetch()} disabled={status.isFetching}>Try again</Button>}>{cloudErrorMessage(status.error)}</EmptyState>;
  if (!ready || isCloudSignedOut(list.error)) return <SignedOut />;
  if (list.isError && !cart) return <EmptyState title="Couldn’t load your shopping list" action={<Button onClick={() => void list.refetch()} disabled={list.isFetching}>Try again</Button>}>{cloudErrorMessage(list.error)}</EmptyState>;
  const error = list.error ?? (m.create.isError ? m.create.error : m.syncBom.isError ? m.syncBom.error : null);
  const syncBom = () => { m.syncBom.reset(); setBomReviewOpen(true); };
  const bomDialog = <ShoppingBomDialog projectId={projectId} open={bomReviewOpen} busy={m.syncBom.isPending} error={m.syncBom.error} onClose={() => setBomReviewOpen(false)} onSync={options => m.syncBom.mutate(options, { onSuccess: ({ summary: s }) => { setBomReviewOpen(false); setNotice(`Synced ${s.parts} part lines · ${s.added} added · ${s.removed} removed · ${s.matched} kept their edits${s.pcbAdded ? " · Board added" : ""}`); } })} />;
  if (!cart) return <><EmptyState title="Your next build starts here" action={<div className="flex flex-wrap justify-center gap-2"><Button size="sm" onClick={() => m.create.mutate()} disabled={pending}>Start an empty list</Button><Button variant="primary" size="sm" onClick={syncBom} disabled={pending} data-testid="shopping-sync-bom">{m.syncBom.isPending ? "Syncing…" : "Import board parts"}</Button></div>}>
    Bring in your bill of materials or add parts yourself. Track everything by supplier, from ordering to delivery.
    {error && <p role="alert" className="shopping-error">{cloudErrorMessage(error)}</p>}
  </EmptyState>{bomDialog}</>;
  const received = cart.items.filter(i => i.status === "received").length;
  const totalQuantity = cart.items.reduce((total, i) => total + i.quantity, 0);
  return <><div className="shopping-list" data-testid="shopping-list">
    <header className="shopping-header">
      <div className="shopping-title-row"><div className="shopping-title"><span className="shopping-eyebrow">Shopping list</span><h2 title={cart.name}>{cart.name}</h2></div>
        <div className="shopping-header-actions">{list.isFetching && <Spinner />}<Button size="sm" onClick={syncBom} disabled={pending || unsaved > 0} data-testid="shopping-sync-bom" title={unsaved ? "Save or discard your edits before syncing board parts" : "Update parts from the board’s bill of materials"}><Icon name="refresh" width={15} height={15} />{m.syncBom.isPending ? "Syncing…" : "Sync from BOM"}</Button>
          {list.data?.cartUrl && <Button size="sm" title="Open shopping list in dashboard" onClick={() => void host.openExternal(list.data!.cartUrl!)}><Icon name="externalLink" width={15} height={15} />Open dashboard</Button>}
          <Button ref={addButton} size="sm" data-testid="shopping-add-open" disabled={m.add.isPending} onClick={() => { setAddMounted(true); setAdding(!adding); }} aria-expanded={adding} aria-controls="shopping-add-panel"><Icon name="plus" width={15} height={15} />{addMounted && !adding ? "Continue adding" : "Add item"}</Button>
        </div>
      </div>
      {cart.repos.length > 0 && <div className="shopping-sources" aria-label="Source repositories"><span>Sources</span>{cart.repos.map(repo => <span className="shopping-source" key={repo} title={repo}>{repo.replace(/^https?:\/\//, "").replace(/\.git$/, "")}</span>)}</div>}
      <div className="shopping-overview"><span>{cart.items.length} items <span aria-hidden="true">·</span> {totalQuantity} units</span><span>{received} of {cart.items.length} received</span></div>
      <div className="shopping-progress" role="progressbar" aria-label="Items received" aria-valuemin={0} aria-valuemax={cart.items.length || 1} aria-valuenow={received}><span style={{ width: `${cart.items.length ? received / cart.items.length * 100 : 0}%` }} /></div>
      <div className="shopping-toolbar"><div className="shopping-search"><Icon name="search" width={16} height={16} /><input type="search" disabled={saving} aria-label="Search shopping list" placeholder="Search parts, references, suppliers…" value={query} onChange={e => setQuery(e.target.value)} /></div></div>
      <div className="shopping-filters" role="group" aria-label="Filter by order status">
        {(["all", ...CART_ITEM_STATUSES] as const).map(s => <button key={s} type="button" disabled={saving} aria-pressed={filter === s} onClick={() => setFilter(s)}>{s === "all" ? "All items" : STATUS_LABEL[s]}<span>{s === "all" ? cart.items.length : cart.items.filter(i => i.status === s).length}</span></button>)}
      </div>
    </header>
    {error && <FeedbackNotice className="fd-shopping-feedback" tone="error" title="Shopping list needs attention" actions={list.isError ? <Button size="sm" onClick={() => void list.refetch()} disabled={list.isFetching}>Try again</Button> : undefined}>{cloudErrorMessage(error)}</FeedbackNotice>}
    {notice && !error && <FeedbackNotice className="fd-shopping-feedback" tone="success" title="Shopping list updated" onDismiss={() => setNotice(null)}>{notice}</FeedbackNotice>}
    {destinations.isError && <FeedbackNotice className="fd-shopping-feedback" tone="warning" title="Couldn’t refresh suppliers" actions={<Button size="sm" onClick={() => void destinations.refetch()} disabled={destinations.isFetching}>Try again</Button>}>Your current supplier and standard suppliers remain available.</FeedbackNotice>}
    <div className="shopping-scroll">
      <div id="shopping-add-panel" className="shopping-disclosure" hidden={!adding} inert={!adding}>{addMounted && <ShoppingAddItem key={projectId} options={options} fab={cart.fabDestinationId} onClose={closeAdd} onAdd={async ({ label, quantity, destinationId }) => {
        await m.add.mutateAsync([{ kind: "part", quantity, destinationId, ...(looksLikeMpn(label) ? { mpn: label } : { description: label }) }]);
        setQuery(""); setFilter("all"); setNotice("Item added to your list.");
      }} />}</div>
      {groups.length === 0 && <div className="shopping-empty"><Icon name={cart.items.length ? "search" : "checklist"} width={28} height={28} /><h3>{cart.items.length ? "No matching items" : "Everything for your next build"}</h3><p>{cart.items.length ? "Try another search or order status." : "Sync your board’s parts or add your first item."}</p>{cart.items.length > 0 && <Button variant="ghost" size="sm" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</Button>}</div>}
      {groups.map(g => <section key={g.destinationId} className="shopping-group" aria-label={`${g.name} items`}>
        <div className="shopping-group-heading"><div className="shopping-supplier-copy"><h3>{g.name}</h3><span>{g.items.length}{query.trim() || filter !== "all" ? ` of ${cart.items.filter(i => i.destinationId === g.destinationId).length}` : ""} items · {g.totalQuantity} units{query.trim() || filter !== "all" ? " shown" : ""}</span></div>{g.url && <button type="button" onClick={() => void host.openExternal(g.url!)} aria-label={`Visit ${g.name}`}>Visit supplier <span aria-hidden="true">↗</span></button>}</div>
        <div className="shopping-column-headings" aria-hidden="true"><span>Item</span><span>Qty</span><span>Status</span><span /></div>
        <ul>{g.items.map(item => <ShoppingItemRow key={item.id} item={item} options={options} draftState={{ value: drafts[item.id], set: value => setDrafts(previous => { const next = { ...previous }; if (value) next[item.id] = value; else delete next[item.id]; return next; }) }} onPatch={async patch => { await m.update.mutateAsync({ itemId: item.id, patch }); setNotice("Changes saved."); }} onRemove={async () => { await m.remove.mutateAsync(item.id); setNotice(`${itemLabel(item)} removed.`); }} />)}</ul>
      </section>)}
    </div>
    <footer className="shopping-footer"><span role="status">{filtered.length === cart.items.length ? "Shared with your team" : `${filtered.length} of ${cart.items.length} items shown`}</span>{unsaved > 0 ? <button type="button" disabled={saving} onClick={() => { setQuery(""); setFilter("all"); }}>{unsaved} unsaved {unsaved === 1 ? "edit" : "edits"} · Show all items</button> : <span>Open an item to edit</span>}</footer>
  </div>{bomDialog}</>;
}
