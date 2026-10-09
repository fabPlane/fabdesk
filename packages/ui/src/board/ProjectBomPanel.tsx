import {
  OFFBOARD_KIND_LABELS,
  OFFBOARD_KINDS,
  PROJECT_PARTS_FILE,
  findOffboardCatalogPart,
  nextOffboardRef,
  projectBomLines,
  searchOffboardCatalog,
  type NetlistFile,
  type OffboardKind,
  type ProjectBomLine,
  type ProjectPartsFile,
} from "@fabdesk/protocol";
import { useProjectJson, useRunTool, useWriteProjectFile } from "@fabdesk/client-core";
import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, Input, Select, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { cn } from "../util";

function emptyParts(): ProjectPartsFile {
  return { schema: 1, parts: [] };
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

export function ProjectBomPanel() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const netlist = useProjectJson<NetlistFile>(projectId, "circuit.netlist.json");
  const partsFile = useProjectJson<ProjectPartsFile>(projectId, PROJECT_PARTS_FILE);
  const write = useWriteProjectFile();
  const exportBom = useRunTool();
  const [filter, setFilter] = useState<"all" | "pcb" | OffboardKind>("all");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<OffboardKind | "">("");
  const [qty, setQty] = useState("1");

  const parts = partsFile.data && partsFile.data.schema === 1 ? partsFile.data : emptyParts();
  const components = netlist.data?.netlist.components ?? [];
  const lines = useMemo(() => projectBomLines(components, parts.parts), [components, parts.parts]);
  const shown = filter === "all" ? lines : lines.filter((l) => l.kind === filter);
  const hits = useMemo(
    () => searchOffboardCatalog(query, { ...(kind ? { kind } : {}), limit: 8 }),
    [query, kind],
  );

  if (!projectId) return <EmptyState title="No project selected" />;
  if (netlist.isLoading || partsFile.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const persist = (next: ProjectPartsFile) =>
    write.mutate({ projectId, path: PROJECT_PARTS_FILE, content: `${JSON.stringify(next, null, 2)}\n` });

  const addCatalog = (catalogId: string) => {
    const catalog = findOffboardCatalogPart(catalogId);
    if (!catalog) return;
    const n = Number(qty);
    const count = Number.isInteger(n) && n > 0 ? n : 1;
    const line = {
      id: `line_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      catalogId: catalog.id,
      ref: nextOffboardRef(
        catalog.kind,
        parts.parts.map((p) => p.ref),
      ),
      name: catalog.name,
      kind: catalog.kind,
      qty: count,
      ...(catalog.mpn ? { mpn: catalog.mpn } : {}),
      ...(catalog.manufacturer ? { manufacturer: catalog.manufacturer } : {}),
    };
    persist({ schema: 1, parts: [...parts.parts, line] });
    setQuery("");
  };

  const setQtyFor = (lineId: string, nextQty: number) => {
    if (!Number.isInteger(nextQty) || nextQty < 1) return;
    persist({
      schema: 1,
      parts: parts.parts.map((p) => (p.id === lineId ? { ...p, qty: nextQty } : p)),
    });
  };

  const removeLine = (lineId: string) =>
    persist({ schema: 1, parts: parts.parts.filter((p) => p.id !== lineId) });

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="project-bom">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <span className="text-[13px] font-medium">Project BOM</span>
        <span className="text-[11px] text-muted">
          {lines.length} line{lines.length === 1 ? "" : "s"} · {parts.parts.length} off-board
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            aria-label="Filter BOM"
            className="h-7 text-xs"
            data-testid="bom-filter"
          >
            <option value="all">All</option>
            <option value="pcb">PCB</option>
            {OFFBOARD_KINDS.map((k) => (
              <option key={k} value={k}>
                {OFFBOARD_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
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
      {exportBom.state.error && <div className="border-b border-border px-2 py-1 text-xs text-danger">{exportBom.state.error}</div>}
      <div className="min-h-0 flex-1 overflow-auto">
        {shown.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-muted">
            {lines.length === 0
              ? "No parts yet. Electrical parts come from the board netlist; add motors, displays or hardware below."
              : "No lines match this filter."}
          </div>
        ) : (
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-panel text-[10.5px] font-semibold uppercase tracking-wide text-muted">
              <tr>
                <th className="px-2 py-1.5">Ref</th>
                <th className="px-2 py-1.5">Name</th>
                <th className="px-2 py-1.5">Kind</th>
                <th className="px-2 py-1.5">Qty</th>
                <th className="px-2 py-1.5">MPN</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {shown.map((line) => (
                <tr
                  key={`${line.source}:${line.lineId ?? line.refs.join(",")}`}
                  className="border-t border-border/60"
                  data-testid={`bom-row-${line.refs[0] ?? line.lineId}`}
                >
                  <td className="px-2 py-1.5 font-mono text-[11px]">{line.refs.join(" ")}</td>
                  <td className="px-2 py-1.5">
                    <div className="font-medium">{line.name}</div>
                    {line.footprint && <div className="font-mono text-[10.5px] text-muted">{line.footprint}</div>}
                  </td>
                  <td className="px-2 py-1.5">
                    <Badge tone={KIND_TONE[line.kind]}>{line.kind === "pcb" ? "PCB" : OFFBOARD_KIND_LABELS[line.kind]}</Badge>
                  </td>
                  <td className="px-2 py-1.5">
                    {line.source === "offboard" && line.lineId ? (
                      <Input
                        type="number"
                        min={1}
                        value={String(line.qty)}
                        aria-label={`Quantity for ${line.refs[0]}`}
                        className="h-7 w-14 px-1.5 text-xs"
                        onChange={(e) => setQtyFor(line.lineId!, Number(e.target.value))}
                      />
                    ) : (
                      line.qty
                    )}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[11px] text-muted">{line.mpn ?? ""}</td>
                  <td className="px-2 py-1.5 text-right">
                    {line.source === "offboard" && line.lineId && (
                      <Button size="sm" variant="ghost" className="text-muted hover:text-danger" onClick={() => removeLine(line.lineId!)}>
                        Remove
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="shrink-0 border-t border-border px-2 py-2" data-testid="offboard-picker">
        <div className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-muted">Add off-board part</div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search motors, displays, standoffs, screws…"
            aria-label="Search off-board library"
            className="text-xs"
            data-testid="offboard-search"
          />
          <Select
            value={kind}
            onChange={(e) => setKind(e.target.value as OffboardKind | "")}
            aria-label="Off-board kind"
            className="h-8 text-xs"
          >
            <option value="">Any kind</option>
            {OFFBOARD_KINDS.map((k) => (
              <option key={k} value={k}>
                {OFFBOARD_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
          <Input
            type="number"
            min={1}
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            aria-label="Quantity to add"
            className="h-8 w-14 px-1.5 text-xs"
          />
        </div>
        <div className="mt-1.5 max-h-36 overflow-auto">
          {hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-panel-2",
              )}
              onClick={() => addCatalog(hit.id)}
              data-testid={`offboard-hit-${hit.id}`}
            >
              <Badge tone={KIND_TONE[hit.kind]}>{OFFBOARD_KIND_LABELS[hit.kind]}</Badge>
              <span className="min-w-0 flex-1 truncate font-medium">{hit.name}</span>
              <span className="truncate font-mono text-[10.5px] text-muted">{hit.mpn ?? hit.id}</span>
              <span className="text-[11px] text-accent">Add</span>
            </button>
          ))}
          {hits.length === 0 && <div className="px-2 py-2 text-[11px] text-muted">No library matches.</div>}
        </div>
      </div>
    </div>
  );
}
