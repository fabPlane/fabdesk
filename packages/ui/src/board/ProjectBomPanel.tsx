import {
  OFFBOARD_KIND_LABELS,
  OFFBOARD_KINDS,
  PROJECT_PARTS_FILE,
  ProjectPartsFile as ProjectPartsFileSchema,
  findOffboardCatalogPart,
  nextOffboardRef,
  projectBomLines,
  searchOffboardCatalog,
  type NetlistFile,
  type OffboardKind,
  type ProjectBomLine,
  type ProjectPartsFile,
} from "@fabdesk/protocol";
import { useBoardSources, useProjectJson, useRunTool, useWriteProjectFile } from "@fabdesk/client-core";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Badge, Button, Dialog, EmptyState, IconButton, Input, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { cn } from "../util";

function emptyParts(): ProjectPartsFile {
  return { schema: 1, parts: [] };
}

export type BomPartsState =
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
  if (q.data === null || q.data === undefined) return { status: "ok", parts: emptyParts(), exists: false };
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
              active ? "border-accent bg-accent/15 text-accent" : "border-border bg-panel text-muted hover:bg-panel-2 hover:text-fg",
            )}
          >
            {value === "all" ? "All parts" : value === "pcb" ? "On PCB" : value === "accessory" ? "Accessories" : `${OFFBOARD_KIND_LABELS[value]}s`}
          </button>
        );
      })}
    </div>
  );
}

function PartsToolbar({ label, query, onQueryChange, selected, onChange, includePcb = false }: {
  label: string;
  query: string;
  onQueryChange: (query: string) => void;
  selected: PartKind[];
  onChange: (next: PartKind[]) => void;
  includePcb?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const filtersId = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" width={15} height={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
          <Input value={query} onChange={(e) => onQueryChange(e.target.value)}
            placeholder={includePcb ? "Search name, reference or part number…" : "Search motors, displays or hardware…"}
            aria-label={label} className="h-8 pl-8 pr-8 text-xs" />
          {query && <IconButton size="xs" title={`Clear ${includePcb ? "BOM" : "library"} search`}
            className="absolute right-1 top-1" onClick={() => onQueryChange("")}><Icon name="close" width={14} height={14} /></IconButton>}
        </div>
        <Button size="sm" variant={open || selected.length ? "secondary" : "ghost"}
          aria-expanded={open} aria-controls={filtersId} onClick={() => setOpen(!open)}
          className={cn("shrink-0", selected.length > 0 && "text-accent")}>
          Filters{selected.length > 0 ? ` (${selected.length})` : ""}
          <Icon name="chevronDown" width={14} height={14} className={open ? "rotate-180" : ""} />
        </Button>
      </div>
      {open && <div id={filtersId}>
        <PartFilters label={`${label} categories`} selected={selected} onChange={onChange} includePcb={includePcb} />
      </div>}
    </div>
  );
}

export function ProjectBomPanel() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const sources = useBoardSources(projectId);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const addTrigger = useRef<HTMLButtonElement>(null);
  const libraryRoot = useRef<HTMLDivElement>(null);
  const netlist = useProjectJson<NetlistFile>(projectId, "circuit.netlist.json");
  const partsFile = useProjectJson<ProjectPartsFile>(projectId, PROJECT_PARTS_FILE);
  const write = useWriteProjectFile();
  const exportBom = useRunTool();
  const [filters, setFilters] = useState<PartKind[]>([]);
  const [query, setQuery] = useState("");
  const [bomQuery, setBomQuery] = useState("");
  const [kinds, setKinds] = useState<PartKind[]>([]);
  const [pendingReveal, setPendingReveal] = useState<{ projectId: string; lineId: string } | null>(null);
  const [highlightedLine, setHighlightedLine] = useState<string | null>(null);
  const addedRow = useRef<HTMLTableRowElement>(null);
  const bomScroll = useRef<HTMLDivElement>(null);


  const partsState = bomPartsState(partsFile);
  const parts = partsState.parts;
  const editable = partsState.status === "ok";
  const addedCatalogIds = new Set(parts.parts.map((part) => part.catalogId));
  const components = netlist.data?.netlist.components ?? [];
  const lines = useMemo(() => projectBomLines(components, parts.parts), [components, parts.parts]);
  const searchTerm = bomQuery.trim().toLowerCase();
  const shown = lines.filter((line) =>
    (filters.length === 0 || filters.includes(line.kind)) &&
    (!searchTerm || [line.name, line.refs.join(" "), line.mpn, line.footprint].join(" ").toLowerCase().includes(searchTerm)),
  );
  const hits = useMemo(
    () => searchOffboardCatalog(query, { limit: Number.MAX_SAFE_INTEGER }).filter((part) => kinds.length === 0 || kinds.includes(part.kind)),
    [query, kinds],
  );

  useEffect(() => {
    if (!pendingReveal || pendingReveal.projectId !== projectId || !addedRow.current || !bomScroll.current) return;
    const container = bomScroll.current;
    const row = addedRow.current;
    const headerHeight = container.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    const rowTop = row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
    const visibleHeight = Math.max(0, container.clientHeight - headerHeight);
    container.scrollTo({
      top: Math.max(0, rowTop - headerHeight - Math.max(0, (visibleHeight - row.offsetHeight) / 2)),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
    });
    setHighlightedLine(pendingReveal.lineId);
    setPendingReveal(null);
  }, [lines, pendingReveal, projectId]);

  useEffect(() => {
    if (!highlightedLine) return;
    const timer = setTimeout(() => setHighlightedLine(null), 2000);
    return () => clearTimeout(timer);
  }, [highlightedLine]);

  if (!projectId) return <EmptyState title="No project selected" />;
  if (netlist.isLoading || partsFile.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const persist = (next: ProjectPartsFile) => {
    if (!editable) return;
    write.mutate({ projectId, path: PROJECT_PARTS_FILE, content: `${JSON.stringify(next, null, 2)}\n` });
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
    requestAnimationFrame(() => addTrigger.current?.focus());
  };

  const setQtyFor = (lineId: string, nextQty: number) => {
    if (!editable || !Number.isInteger(nextQty) || nextQty < 1) return;
    persist({
      schema: 1,
      parts: parts.parts.map((p) => (p.id === lineId ? { ...p, qty: nextQty } : p)),
    });
  };

  const removeLine = (lineId: string) =>
    persist({ schema: 1, parts: parts.parts.filter((p) => p.id !== lineId) });

  return (
    <div className="fd-project-parts flex h-full min-h-0 flex-col" data-testid="project-bom">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Project parts</h2>
            <span className="text-xs text-muted">{lines.length} items</span>
            <Badge tone="accent" title="Off-board parts are separate from components mounted on the PCB.">
              {parts.parts.length} off-board
            </Badge>
          </div>
          <p className="mt-1 text-xs text-muted">{sources.data?.mode === "assembly" ? "Project extras and saved root netlist only. Member-board BOMs are not included." : sources.isPending || sources.isError ? "Project extras and saved root netlist. Board membership has not been verified." : "Saved board netlist and project hardware. Source freshness is unverified."}</p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Button ref={addTrigger} variant="primary" size="sm" onClick={() => setLibraryOpen(true)}><Icon name="plus" width={15} height={15} />Add parts</Button>

          <Button
            size="sm"
            disabled={exportBom.state.status === "running"}
            onClick={() => void exportBom.run("export_bom", { projectId })}
            data-testid="bom-export"
          >
            {exportBom.state.status === "running" ? "Exporting..." : "Export CSV"}
          </Button>
        </div>
      </div>
      <div className="shrink-0 border-b border-border px-2 py-2" data-testid="bom-filter">
        <PartsToolbar label="Search BOM" query={bomQuery} onQueryChange={setBomQuery} selected={filters} onChange={setFilters} includePcb />
      </div>
      {(netlist.isError || netlist.parseError) && <div role="alert" className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-warning"><span className="min-w-0 flex-1">The saved electrical netlist could not be read. Listed hardware does not establish PCB component coverage.</span><Button size="sm" variant="ghost" onClick={() => void netlist.refetch()}>Retry netlist</Button></div>}
      {exportBom.state.error && <div className="border-b border-border px-2 py-1 text-xs text-danger">{exportBom.state.error}</div>}
      {partsState.status === "error" && (
        <div
          className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-xs text-danger"
          role="alert"
          data-testid="bom-parts-error"
        >
          <span className="min-w-0 flex-1">{partsState.message} Off-board editing is off so the file is not overwritten.</span>
          <Button size="sm" onClick={() => void partsFile.refetch()}>
            Retry
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1">
          <div ref={bomScroll} id="project-bom-lines" className="h-full min-h-0 overflow-auto" aria-label="Project BOM lines">
            {shown.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted">
                {lines.length === 0
                  ? "No parts are listed in the saved netlist or project parts file. Choose Add parts for motors, displays and hardware."
                  : "No parts match your search or filters."}
              </div>
            ) : (
              <table className="w-full text-left text-[12px]">
                <thead className="sticky top-0 bg-panel text-[10.5px] font-semibold uppercase tracking-wide text-muted">
                  <tr>
                    <th scope="col" className="w-10 px-2 py-1.5 text-right" aria-label="Row number">#</th>
                    <th className="px-2 py-1.5">Ref</th>
                    <th className="px-2 py-1.5">Part</th>
                    <th className="px-2 py-1.5">Type</th>
                    <th className="w-20 px-2 py-1.5">Qty</th>
                    <th className="px-2 py-1.5">Part number</th>
                    <th className="px-2 py-1.5" />
                  </tr>
                </thead>
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
                      <td className="px-2 py-1.5 font-mono text-[11px] text-muted">{line.mpn ?? ""}</td>
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
      </div>
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
