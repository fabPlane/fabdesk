import {
  OFFBOARD_KIND_LABELS,
  OFFBOARD_KINDS,
  PROJECT_PARTS_FILE,
  ProjectPartsFile as ProjectPartsFileSchema,
  findOffboardCatalogPart,
  nextOffboardRef,
  searchOffboardCatalog,
  type OffboardKind,
  type ProjectBomLine,
  type ProjectPartsFile,
} from "@fabdesk/protocol";
import { useCoreClient, useProjectBom, useProjectJson, useRunTool, useWriteProjectFile } from "@fabdesk/client-core";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Dialog, EmptyState, IconButton, Input, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { BomOrigins } from "./BomOrigins";
import { DEFAULT_PARTS_VIEW, useUiStore } from "../stores/ui";
import "./project-bom.css";
import { cn } from "../util";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";

function emptyParts(): ProjectPartsFile {
  return { schema: 1, parts: [] };
}

export type BomPartsState =
  | { status: "loading"; parts: ProjectPartsFile }
  | { status: "ok"; parts: ProjectPartsFile; exists: boolean }
  | { status: "error"; parts: ProjectPartsFile; message: string };

/**
 * Only a confirmed-absent file (404) starts empty. An unreadable, unparsable or unsupported file is
 * an error: editing would persist a replacement built from nothing and drop the existing lines.
 */
export function bomPartsState(q: {
  data: unknown;
  parseError: string | null;
  isError: boolean;
  error?: unknown;
}): BomPartsState {
  if (q.isError) {
    const msg = q.error instanceof Error ? q.error.message : String(q.error ?? "read failed");
    return { status: "error", parts: emptyParts(), message: `Could not read ${PROJECT_PARTS_FILE}: ${msg}` };
  }
  if (q.parseError)
    return { status: "error", parts: emptyParts(), message: `${PROJECT_PARTS_FILE} is not valid JSON: ${q.parseError}` };
  if (q.data === undefined) return { status: "loading", parts: emptyParts() };
  if (q.data === null) return { status: "ok", parts: emptyParts(), exists: false };
  const parsed = ProjectPartsFileSchema.safeParse(q.data);
  if (!parsed.success) {
    const schema = (q.data as { schema?: unknown }).schema;
    return {
      status: "error",
      parts: emptyParts(),
      message:
        schema !== 1
          ? `${PROJECT_PARTS_FILE} uses unsupported schema ${JSON.stringify(schema)}; this version edits schema 1.`
          : `${PROJECT_PARTS_FILE} does not match schema 1: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  return { status: "ok", parts: parsed.data, exists: true };
}

/** The parts file after adding a catalog line, or null when the current file must not be replaced. */
export function planAddOffboard(
  state: BomPartsState,
  catalogId: string,
  qty: number,
  newId: () => string = () => `line_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
): ProjectPartsFile | null {
  if (state.status !== "ok") return null;
  const catalog = findOffboardCatalogPart(catalogId);
  if (!catalog || state.parts.parts.some((part) => part.catalogId === catalog.id)) return null;
  const count = Number.isInteger(qty) && qty > 0 ? qty : 1;
  const parts = state.parts.parts;
  return {
    schema: 1,
    parts: [
      ...parts,
      {
        id: newId(),
        catalogId: catalog.id,
        ref: nextOffboardRef(
          catalog.kind,
          parts.map((p) => p.ref),
        ),
        name: catalog.name,
        kind: catalog.kind,
        qty: count,
        ...(catalog.mpn ? { mpn: catalog.mpn } : {}),
        ...(catalog.manufacturer ? { manufacturer: catalog.manufacturer } : {}),
      },
    ],
  };
}

const KIND_TONE: Record<ProjectBomLine["kind"], "neutral" | "accent" | "warning" | "success"> = {
  pcb: "neutral",
  motor: "accent",
  display: "success",
  standoff: "warning",
  fastener: "warning",
  enclosure: "warning",
  accessory: "accent",
};

type PartKind = ProjectBomLine["kind"];

function PartFilters({ label, selected, onChange, includePcb = false }: {
  label: string;
  selected: PartKind[];
  onChange: (next: PartKind[]) => void;
  includePcb?: boolean;
}) {
  const options: (PartKind | "all")[] = ["all", ...(includePcb ? ["pcb" as const] : []), ...OFFBOARD_KINDS];
  return (
    <div role="group" aria-label={label} className="flex w-full flex-wrap items-center gap-1.5">
      {options.map((value) => {
        const active = value === "all" ? selected.length === 0 : selected.includes(value);
        return (
          <button key={value} type="button" aria-pressed={active}
            onClick={() => onChange(value === "all" ? [] : selected.includes(value) ? selected.filter((k) => k !== value) : [...selected, value])}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-full border px-3 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent",
              active ? "border-accent bg-accent/15 text-accent" : "border-border bg-panel text-fg hover:bg-panel-2",
            )}
          >
            {value === "all" ? "All parts" : value === "pcb" ? "On PCB" : value === "accessory" ? "Accessories" : `${OFFBOARD_KIND_LABELS[value]}s`}
          </button>
        );
      })}
    </div>
  );
}

function PartsToolbar({ label, query, onQueryChange, selected, onChange, includePcb = false, expanded, onExpandedChange }: {
  expanded?: boolean;
  onExpandedChange?: (open: boolean) => void;
  label: string;
  query: string;
  onQueryChange: (query: string) => void;
  selected: PartKind[];
  onChange: (next: PartKind[]) => void;
  includePcb?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = expanded ?? localOpen;
  const setOpen = onExpandedChange ?? setLocalOpen;
  const filtersId = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" width={15} height={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <Input ref={searchInput} value={query} onChange={(e) => onQueryChange(e.target.value)}
            placeholder={includePcb ? "Search name, reference or part number…" : "Search motors, displays or hardware…"}
            aria-label={label} className="h-8 pl-8 pr-8 text-xs" />
          {query && <IconButton size="xs" title={`Clear ${includePcb ? "BOM" : "library"} search`}
            className="absolute right-1 top-1" onClick={() => { onQueryChange(""); searchInput.current?.focus(); }}><Icon name="close" width={14} height={14} /></IconButton>}
        </div>
        <Button size="sm" variant={open || selected.length ? "secondary" : "ghost"}
          aria-label={`Filter parts${selected.length ? ` · ${selected.length} active` : ""}`} title="Filter parts"
          aria-expanded={open} aria-controls={filtersId} onClick={() => setOpen(!open)}
          className={cn("shrink-0", selected.length > 0 && "text-accent")}>
          <Icon name="filter" width={18} height={18} />{selected.length > 0 && <span>{selected.length}</span>}
        </Button>
      </div>
      {open && <div id={filtersId}>
        <PartFilters label={`${label} categories`} selected={selected} onChange={onChange} includePcb={includePcb} />
      </div>}
    </div>
  );
}

function BomColumns() {
  return <colgroup><col style={{ width: 64 }} /><col style={{ width: 130 }} /><col /><col style={{ width: 100 }} /><col style={{ width: 90 }} /><col style={{ width: 120 }} /><col style={{ width: 190 }} /><col style={{ width: 48 }} /></colgroup>;
}
function BomHead({ batchCount, screenReaderOnly = false }: { batchCount: number | null; screenReaderOnly?: boolean }) {
  return <thead className={screenReaderOnly ? "sr-only" : undefined}><tr>
    <th scope="col" aria-label="Row number">#</th><th scope="col">Ref</th><th scope="col">Part</th><th scope="col">Type</th><th scope="col">Per build</th><th scope="col">{batchCount !== null ? `For ${batchCount.toLocaleString()} builds` : "Batch quantity"}</th><th scope="col">Part number</th><th scope="col"><span className="sr-only">Actions</span></th>
  </tr></thead>;
}

export function ProjectBomPanel() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const bom = useProjectBom(projectId), client = useCoreClient();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const libraryRoot = useRef<HTMLDivElement>(null);
  const partsFile = useProjectJson<ProjectPartsFile>(projectId, PROJECT_PARTS_FILE);
  const write = useWriteProjectFile();
  const exportBom = useRunTool();
  const [exportOpen, setExportOpen] = useState(false), [allowPartial, setAllowPartial] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null), [downloading, setDownloading] = useState(false);
  const viewKey = `${client.baseUrl}:${projectId}`;
  const view = useUiStore(s => s.partsViewByProject[viewKey] ?? DEFAULT_PARTS_VIEW);
  const rememberView = (patch: Parameters<ReturnType<typeof useUiStore.getState>["rememberPartsView"]>[1]) => useUiStore.getState().rememberPartsView(viewKey, patch);
  const filters = view.kinds, setFilters = (kinds: PartKind[]) => rememberView({ kinds });
  const [query, setQuery] = useState("");
  const bomQuery = view.query, setBomQuery = (query: string) => rememberView({ query });
  const buildQuantity = view.buildQuantity, setBuildQuantity = (buildQuantity: string) => rememberView({ buildQuantity });
  const batchCount = Number(buildQuantity);
  const validBatch = Number.isInteger(batchCount) && batchCount > 0 && batchCount <= 10000;
  const [kinds, setKinds] = useState<PartKind[]>([]);
  const [pendingReveal, setPendingReveal] = useState<{ projectId: string; lineId: string } | null>(null);
  const [highlightedLine, setHighlightedLine] = useState<string | null>(null);
  const addedRow = useRef<HTMLTableRowElement>(null);
  const bomScroll = useRef<HTMLDivElement>(null);
  const tableScroll = useRef<HTMLDivElement>(null), headerScroll = useRef<HTMLDivElement>(null), resultsAnchor = useRef<HTMLDivElement>(null);
  const savedScroll = useRef({ scrollTop: view.scrollTop, scrollLeft: view.scrollLeft });
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || !bomScroll.current || !bom.data) return;
    restored.current = true;
    bomScroll.current.scrollTop = savedScroll.current.scrollTop;
    if (tableScroll.current) tableScroll.current.scrollLeft = savedScroll.current.scrollLeft;
    if (headerScroll.current) headerScroll.current.scrollLeft = savedScroll.current.scrollLeft;
  }, [bom.data, partsFile.isLoading]);
  useEffect(() => () => { useUiStore.getState().rememberPartsView(viewKey, savedScroll.current); }, [viewKey]);
  const resetResultsPosition = () => {
    if (bomScroll.current && resultsAnchor.current) bomScroll.current.scrollTop = Math.min(bomScroll.current.scrollTop, resultsAnchor.current.offsetTop);
  };
  const syncHorizontal = (from: HTMLDivElement, to: HTMLDivElement | null) => {
    if (to && to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft;
    savedScroll.current.scrollLeft = from.scrollLeft;
  };


  const partsState = bomPartsState(partsFile);
  const parts = partsState.parts;
  const editable = partsState.status === "ok";
  const addedCatalogIds = new Set(parts.parts.map((part) => part.catalogId));
  const lines = bom.data?.lines ?? [];
  const partsPerBuild = lines.reduce((sum, line) => sum + line.qty, 0);
  useEffect(() => { setAllowPartial(false); }, [bom.data?.revision]);
  useAssistantSurface(projectId ? { projectId, label: "Parts / Design BOM", priority: 10, details: JSON.stringify({ revision: bom.data?.revision, sourceCoverage: bom.data?.coverage, completeSourceCoverage: bom.data?.complete, lines: lines.length, buildQuantity: validBatch ? batchCount : null, partsPerBuild, electricalParity: "not established by BOM", error: bom.error instanceof Error ? bom.error.message : undefined }) } : null);
  const searchTerm = bomQuery.trim().toLowerCase();
  const shown = lines.filter((line) =>
    (filters.length === 0 || filters.includes(line.kind)) &&
    (!searchTerm || [line.name, line.refs.join(" "), line.mpn, line.sku, line.footprint].join(" ").toLowerCase().includes(searchTerm)),
  );
  const hits = useMemo(
    () => searchOffboardCatalog(query, { limit: Number.MAX_SAFE_INTEGER }).filter((part) => kinds.length === 0 || kinds.includes(part.kind)),
    [query, kinds],
  );

  useEffect(() => {
    if (libraryOpen || !pendingReveal || pendingReveal.projectId !== projectId || !addedRow.current || !bomScroll.current) return;
    const container = bomScroll.current;
    const row = addedRow.current;
    const headerHeight = container.querySelector("[data-testid=bom-filter]")?.getBoundingClientRect().height ?? 0;
    const rowTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const visibleHeight = Math.max(0, container.clientHeight - headerHeight);
    container.scrollTo({
      top: Math.max(0, rowTop - headerHeight - Math.max(0, (visibleHeight - row.offsetHeight) / 2)),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    setHighlightedLine(pendingReveal.lineId);
    setPendingReveal(null);
    requestAnimationFrame(() => {
      if (row.isConnected && useUiStore.getState().activeProjectId === projectId) row.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    });
  }, [lines, pendingReveal, projectId, libraryOpen]);

  useEffect(() => {
    if (!highlightedLine) return;
    const timer = setTimeout(() => setHighlightedLine(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightedLine]);

  if (!projectId) return <EmptyState title="No project selected" />;
  if (bom.isLoading || partsFile.isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" role="status">
        <Spinner />
        <strong className="text-sm font-medium">Reading parts for this build…</strong>
        <p className="max-w-sm text-xs leading-5 text-muted">Loading saved design sources and project hardware. You can keep working and follow design tasks in Project activity.</p>
      </div>
    );
  }

  const persist = (next: ProjectPartsFile, focusAdd = false) => {
    if (!editable) return;
    write.mutate({ projectId, path: PROJECT_PARTS_FILE, content: `${JSON.stringify(next, null, 2)}\n` }, {
      onSuccess: () => {
        if (focusAdd && useUiStore.getState().activeProjectId === projectId) requestAnimationFrame(() => addTrigger.current?.focus());
      },
    });
  };

  const addCatalog = (catalogId: string) => {
    if (write.isPending) return;
    const next = planAddOffboard(partsState, catalogId, 1);
    if (!next || !projectId) return;
    const lineId = next.parts.at(-1)!.id;
    write.mutate({ projectId, path: PROJECT_PARTS_FILE, content: `${JSON.stringify(next, null, 2)}\n` }, {
      onSuccess: () => {
        setFilters([]);
        setBomQuery("");
        setPendingReveal({ projectId, lineId });
        requestAnimationFrame(() => libraryRoot.current?.querySelector<HTMLInputElement>("input")?.focus());
      },
    });
  };

  const revealCatalogPart = (catalogId: string) => {
    const part = parts.parts.find((part) => part.catalogId === catalogId);
    if (!part || !projectId) return;
    setFilters([]);
    setBomQuery("");
    setLibraryOpen(false);
    setPendingReveal({ projectId, lineId: part.id });
  };

  const setQtyFor = (lineId: string, nextQty: number) => {
    if (!editable || !Number.isInteger(nextQty) || nextQty < 1) return;
    persist({
      schema: 1,
      parts: parts.parts.map((p) => (p.id === lineId ? { ...p, qty: nextQty } : p)),
    });
  };

  const removeLine = (lineId: string) =>
    persist({ schema: 1, parts: parts.parts.filter((p) => p.id !== lineId) }, lines.length === 1);

  const downloadBom = async () => {
    if (!bom.data || bom.isFetching || downloading || !lines.length || (!bom.data.complete && !allowPartial)) return;
    setDownloading(true); setDownloadError(null);
    try {
      const result = await exportBom.run("export_bom", { projectId, expectedRevision: bom.data.revision, allowPartial });
      if (result.status !== "done") return;
      const blob = await client.readFileBlob(projectId, "exports/bom.csv");
      if (useUiStore.getState().activeProjectId !== projectId) return;
      const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = "bom.csv"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setExportOpen(false);
    } catch (error) { setDownloadError(error instanceof Error ? error.message : "Could not download BOM. Try again."); }
    finally { setDownloading(false); }
  };

  return (
    <div ref={bomScroll} className="fd-project-parts fd-bom-page" data-testid="project-bom" onScroll={event => { savedScroll.current.scrollTop = event.currentTarget.scrollTop; }}>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Parts for this build</h2>
            <span className="text-xs text-muted">{bom.isError && !bom.data ? "Parts unavailable" : <>{bom.isError ? "Last read: " : ""}{lines.length} BOM {lines.length === 1 ? "line" : "lines"} · {partsPerBuild} parts per build</>}</span>
            {lines.some(line => line.source === "offboard") && <Badge tone="accent" title="Extra hardware counted once per build, separate from components mounted on the PCB.">
              {lines.filter(line => line.source === "offboard").reduce((sum, line) => sum + line.qty, 0)} extra hardware
            </Badge>}
          </div>
          <p className="mt-1 text-xs text-muted">{bom.data?.complete && editable && !bom.isError ? "Quantities cover one complete build, including all declared boards and project hardware." : "Showing available quantities for one build. Review missing or unverified board designs below."}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button ref={addTrigger} variant="primary" size="sm" onClick={() => setLibraryOpen(true)}><Icon name="plus" width={15} height={15} />Add hardware</Button>
          <Button size="sm" disabled={bom.isFetching} onClick={() => void bom.refetch()}>{bom.isFetching ? "Reading sources…" : "Refresh parts"}</Button>

          <Button
            size="sm"
            disabled={downloading || bom.isFetching || bom.isError || lines.length === 0}
            onClick={() => setExportOpen(true)}
            data-testid="bom-export"
          >
            {downloading ? "Exporting…" : "Export CSV"}
          </Button>
        </div>
      </div>
      {bom.data && <BomOrigins snapshot={bom.data} hardwareState={partsState.status} refreshFailed={bom.isError} open={view.sourcesOpen} onOpenChange={sourcesOpen => rememberView({ sourcesOpen })} />}
      {lines.length > 0 && <div className="fd-bom-batch shrink-0">
        <label className="flex items-center gap-2 text-sm">Build quantity<Input type="number" min={1} max={10000} step={1} value={buildQuantity} onChange={event => setBuildQuantity(event.target.value)} aria-label="Build quantity" className="w-24" /></label>
        <span className="text-sm" role="status">{validBatch ? `${(partsPerBuild * batchCount).toLocaleString()} parts for ${batchCount.toLocaleString()} ${batchCount === 1 ? "build" : "builds"}` : "Enter a whole quantity from 1 to 10,000."}</span>
        <Button size="sm" disabled={!validBatch || bom.isFetching || bom.isError} onClick={() => {
          if (!projectId || !validBatch) return;
          askAboutSurface({ projectId, label: "Parts / Batch sourcing", priority: 40, details: JSON.stringify({ revision: bom.data?.revision, coverage: bom.data?.coverage, buildQuantity: batchCount, lines: lines.map(line => ({ refs: line.refs, name: line.name, mpn: line.mpn, sku: line.sku, qtyPerBuild: line.qty, required: line.qty * batchCount })) }) }, `Review sourcing for ${batchCount} complete builds. Verify current immediate assembly stock for every assembled component and its required quantity, exact part identifier and Basic/Extended status. Flag missing information and request approval for any exception before choosing a replacement. Do not change the design while sourcing is unresolved.`);
        }}><Icon name="sparkles" width={15} height={15} />Ask about sourcing</Button>
        <span className="fd-bom-planning-note">Planning only · CSV quantities stay per build</span>
      </div>}
      {bom.isError && partsState.status !== "error" && <div role="alert" className="fd-bom-read-error"><div><strong>Could not refresh parts</strong><span>Listed quantities may be from an earlier read.</span></div><Button size="sm" onClick={() => void bom.refetch()}>Retry</Button><details><DisclosureSummary icon="warning" label="Read error details" variant="compact" /><p>{bom.error instanceof Error ? bom.error.message : "Could not read the project BOM."}</p></details></div>}
      {exportBom.state.error && <div className="border-b border-border px-2 py-1 text-xs text-danger">{exportBom.state.error}</div>}
      {partsState.status === "error" && <div role="alert" data-testid="bom-parts-error" className="fd-bom-read-error">
        <div><strong>Extra hardware could not be read</strong><span>Editing is paused to protect project.parts.json.{bom.isError ? bom.data ? " Listed quantities are from an earlier read." : " No complete parts list is available." : ""}</span></div>
        <Button size="sm" onClick={() => { void partsFile.refetch(); void bom.refetch(); }}>Retry</Button>
        <details><DisclosureSummary icon="warning" label="Read error details" variant="compact" /><p>{partsState.message}</p></details>
      </div>}
      <div ref={resultsAnchor} />
      {lines.length > 0 && <div className="fd-bom-sticky" data-testid="bom-filter">
        <div className="fd-bom-search-row">
          <PartsToolbar label="Search BOM" query={bomQuery} onQueryChange={query => { setBomQuery(query); resetResultsPosition(); }} selected={filters} onChange={kinds => { setFilters(kinds); resetResultsPosition(); }} includePcb expanded={view.filtersOpen} onExpandedChange={filtersOpen => rememberView({ filtersOpen })} />
          <div className="fd-bom-results" role="status">{shown.length} of {lines.length} lines{(bomQuery || filters.length > 0) && <Button size="sm" onClick={() => { setBomQuery(""); setFilters([]); resetResultsPosition(); }}>Clear filters</Button>}</div>
        </div>
        {shown.length > 0 && <div className="fd-bom-columns-scroll" ref={headerScroll} onScroll={event => syncHorizontal(event.currentTarget, tableScroll.current)}>
          <table className="fd-bom-table" aria-hidden="true"><BomColumns /><BomHead batchCount={validBatch ? batchCount : null} /></table>
        </div>}
      </div>}
      <div ref={tableScroll} id="project-bom-lines" className="fd-bom-table-scroll" aria-label="Project BOM lines" tabIndex={0} onScroll={event => syncHorizontal(event.currentTarget, headerScroll.current)} onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
        event.preventDefault();
        event.currentTarget.scrollLeft += event.key === "ArrowRight" ? 80 : -80;
      }}>
            {shown.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted">
                {bom.isError
                  ? "Parts could not be loaded. Use Retry above to read the design and hardware files again."
                  : lines.length === 0
                  ? "No included parts are listed yet. Review Parts sources or choose Add hardware."
                  : "No parts match your search or filters."}
                {(bomQuery || filters.length > 0) && <Button className="mt-3" size="sm" onClick={() => { setBomQuery(""); setFilters([]); resetResultsPosition(); }}>Show all parts</Button>}
              </div>
            ) : (
              <table className="fd-bom-table">
                <caption className="sr-only">Parts per build and required quantities for this project</caption>
                <BomColumns />
                <BomHead batchCount={validBatch ? batchCount : null} screenReaderOnly />
                <tbody>
                  {shown.map((line) => (
                    <tr
                      key={`${line.source}:${line.lineId ?? line.refs.join(",")}`}
                      ref={pendingReveal?.projectId === projectId && pendingReveal.lineId === line.lineId ? addedRow : undefined}
                      className={cn("border-t border-border/60 transition-colors", highlightedLine === line.lineId && "bg-accent/10")}
                      data-testid={`bom-row-${line.refs[0] ?? line.lineId}`}
                    >
                      <td className="w-10 px-2 py-1.5 text-right text-[11px] tabular-nums text-muted">{lines.indexOf(line) + 1}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px]">{line.refs.join(" ")}</td>
                      <td className="px-2 py-1.5">
                        <div className="font-medium" title={line.footprint ?? line.name}>{line.name}</div>
                      </td>
                      <td className="px-2 py-1.5">
                        <Badge tone={KIND_TONE[line.kind]} title={line.source === "offboard" ? "Off-board part" : "Component mounted on the PCB"}>
                          {line.kind === "pcb" ? "On PCB" : OFFBOARD_KIND_LABELS[line.kind]}
                        </Badge>
                      </td>
                      <td className="w-20 px-2 py-1.5">
                        {line.source === "offboard" && line.lineId && editable ? (
                          <Input
                            type="number"
                            min={1}
                            value={String(line.qty)}
                            aria-label={`Quantity for ${line.refs[0]}`}
                            className="h-7 px-1.5 text-xs"
                            style={{ width: 64 }}
                            onChange={(e) => setQtyFor(line.lineId!, Number(e.target.value))}
                          />
                        ) : (
                          line.qty
                        )}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums">{validBatch ? (line.qty * batchCount).toLocaleString() : "—"}</td>
                      <td className="px-2 py-1.5 text-[11px] text-muted"><span className="font-mono">{line.mpn ?? "—"}</span>{line.sku && <div className="mt-1">Saved supplier ID: <span className="font-mono">{line.sku}</span></div>}</td>
                      <td className="px-2 py-1.5 text-right">
                        {line.source === "offboard" && line.lineId && editable && (
                          <IconButton size="sm" title={`Remove ${line.refs[0] ?? line.name}`} className="text-muted hover:text-danger" onClick={() => removeLine(line.lineId!)}>
                            <Icon name="trash" />
                          </IconButton>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
      </div>
      <Dialog open={exportOpen} closeDisabled={downloading} title="Export bill of materials" onClose={() => { if (!downloading) setExportOpen(false); }}>
        <div className="space-y-4 text-sm">
          <p>{lines.length} listed items. The CSV includes board-qualified references, quantities, footprints and saved part numbers.</p>
          {!bom.data?.complete && <div className="rounded-lg border border-warning/30 bg-warning/5 p-3"><p className="font-medium text-warning">Some board sources need review</p><p className="mt-1 text-xs text-muted">Missing sources are omitted. Saved netlist parts have not been checked against native schematic exclusions.</p><label className="mt-3 flex items-start gap-2"><input type="checkbox" checked={allowPartial} onChange={event => setAllowPartial(event.target.checked)} disabled={downloading} /><span>Export only the listed parts</span></label></div>}
          <p className="text-xs text-muted">This is a design CSV with per-build quantities, including project hardware. The batch planning quantity does not change this file. It is not a manufacturer-specific assembly upload.</p>
          <p className="text-xs text-muted">Saved to Outputs as bom.csv with a source coverage receipt, then downloaded. This does not mark the design as electrically checked.</p>
          {(downloadError || exportBom.state.error) && <p role="alert" className="text-danger">{downloadError || exportBom.state.error}</p>}
          <div className="flex justify-end gap-2"><Button disabled={downloading} onClick={() => setExportOpen(false)}>Cancel</Button><Button variant="primary" disabled={downloading || bom.isFetching || bom.isError || !lines.length || (!bom.data?.complete && !allowPartial)} onClick={() => void downloadBom()}>{downloading ? "Exporting…" : "Export and download CSV"}</Button></div>
        </div>
      </Dialog>
      <Dialog open={libraryOpen} title="Add project parts" className="!w-[780px]" onClose={() => { setLibraryOpen(false); requestAnimationFrame(() => addTrigger.current?.focus()); }}>
          <div ref={libraryRoot} className="fd-parts-library flex min-h-0 flex-col" data-testid="offboard-picker">
            <div className="shrink-0 border-b border-border bg-panel px-3 py-3">
              <div className="mb-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold">Add off-board parts</h2>
                  <span className="text-xs text-muted">{hits.length} available</span>
                </div>
                <p className="mt-1 text-xs text-muted">Choose motors, displays and hardware. Quantities are edited in the project parts list.</p>
              </div>
              <PartsToolbar label="Search off-board library" query={query} onQueryChange={setQuery} selected={kinds} onChange={setKinds} />
              <div className="mt-3 grid items-center gap-2 px-2 text-[10.5px] font-semibold uppercase tracking-wide text-muted" style={{ gridTemplateColumns: "80px minmax(0, 1fr) minmax(0, 160px) 48px 28px" }} aria-hidden="true">
                <span>Type</span><span>Part</span><span className="text-right">Part number</span><span /><span />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3 py-1.5" aria-label="Parts library results">
              {hits.map((hit) => (
                <div key={hit.id} className="grid w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-panel-2" style={{ gridTemplateColumns: "80px minmax(0, 1fr) minmax(0, 160px) 48px 28px" }}>
                  <span><Badge tone={KIND_TONE[hit.kind]}>{OFFBOARD_KIND_LABELS[hit.kind]}</Badge></span>
                  <span className="min-w-0 flex-1 truncate font-medium">{hit.name}</span>
                  <span className="truncate text-right font-mono text-[10.5px] text-muted" title={hit.mpn ?? hit.id}>{hit.mpn ?? "—"}</span>
                  <span className="text-right">
                    {addedCatalogIds.has(hit.id) && (
                      <button type="button" onClick={() => revealCatalogPart(hit.id)}
                        aria-label={`Show ${hit.name} in project parts`}
                        title="Show in project parts"
                        className="cursor-pointer rounded text-[11px] font-medium text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
                        In BOM
                      </button>
                    )}
                  </span>
                  <IconButton
                    size="sm"
                    title={addedCatalogIds.has(hit.id) ? `${hit.name} is already in BOM — edit its quantity in project parts` : `Add ${hit.name}`}
                    disabled={!editable || write.isPending || addedCatalogIds.has(hit.id)}
                    className={addedCatalogIds.has(hit.id) ? "disabled:opacity-100 text-accent" : "fd-bom-add"}
                    aria-label={addedCatalogIds.has(hit.id) ? `${hit.name} — already in BOM` : `Add ${hit.name}`}
                    onClick={() => addCatalog(hit.id)}
                    data-testid={`offboard-hit-${hit.id}`}
                  >
                    <Icon name={addedCatalogIds.has(hit.id) ? "check" : "plus"} />
                  </IconButton>
                </div>
              ))}
              {hits.length === 0 && <div className="px-2 py-2 text-[11px] text-muted">No library matches.</div>}
            </div>
          </div>
        <div className="flex justify-end border-t border-border pt-3"><Button onClick={() => { setLibraryOpen(false); requestAnimationFrame(() => addTrigger.current?.focus()); }}>Done</Button></div>
      </Dialog>
    </div>
  );
}
