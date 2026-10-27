import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useProjectJson } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { CheckReportStatus } from "./CheckReportStatus";
import { cn } from "../util";
import { useRunTool } from "@fabdesk/client-core";

export interface ViolationItem {
  description: string;
  pos?: { x: number; y: number };
}

export interface Violation {
  source: "drc" | "erc";
  type: string;
  severity: string;
  description: string;
  items: ViolationItem[];
  excluded?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function normalizeItem(v: unknown): ViolationItem {
  const r = asRecord(v);
  if (!r) return { description: String(v) };
  const pos = asRecord(r["pos"]);
  const x = pos?.["x"];
  const y = pos?.["y"];
  return {
    description: typeof r["description"] === "string" ? r["description"] : JSON.stringify(v),
    ...(typeof x === "number" && typeof y === "number" ? { pos: { x, y } } : {}),
  };
}

function normalizeViolation(v: unknown, source: "drc" | "erc"): Violation | null {
  const r = asRecord(v);
  if (!r) return null;
  return {
    source,
    type: typeof r["rule"] === "string" ? r["rule"] : typeof r["type"] === "string" ? r["type"] : "unknown",
    severity: typeof r["severity"] === "string" ? r["severity"] : "error",
    description: typeof r["description"] === "string" ? r["description"] : JSON.stringify(v),
    items: Array.isArray(r["items"]) ? r["items"].map(normalizeItem) : [],
    ...(r["excluded"] === true ? { excluded: true } : {}),
  };
}

/** Flattens KiCad `kicad-cli pcb drc --format json` / `sch erc --format json` reports (and plain arrays). */
export function normalizeReport(json: unknown, source: "drc" | "erc"): Violation[] {
  if (!json) return [];
  if (Array.isArray(json)) return json.map((v) => normalizeViolation(v, source)).filter((v): v is Violation => !!v);
  const r = asRecord(json);
  if (!r) return [];
  const out: Violation[] = [];
  // Saved tool reports use normalized camelCase keys; raw KiCad reports use snake_case.
  // Prefer the normalized category if both are present, so raw payloads are not counted twice.
  for (const [keys, unconnected] of [
    [["violations"], false],
    [["unconnected", "unconnected_items"], true],
    [["schematicParity", "schematic_parity"], false],
  ] as const) {
    const arr = keys.map(key => r[key]).find(Array.isArray);
    if (Array.isArray(arr)) for (const v of arr) {
      const n = normalizeViolation(v, source);
      if (n) out.push(unconnected ? { ...n, type: n.type === "unknown" ? "unconnected" : n.type } : n);
    }
  }
  const sheets = r["sheets"];
  if (Array.isArray(sheets)) for (const sheet of sheets) out.push(...normalizeReport(sheet, source));
  return out;
}

export function DrcTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const drc = useProjectJson(projectId, "reports/drc.json");
  const erc = useProjectJson(projectId, "reports/erc.json");
  const [selected, setSelected] = useState<number | null>(null);
  const tool = useRunTool();
  const rows = useMemo(
    () => [...normalizeReport(drc.data, "drc"), ...normalizeReport(erc.data, "erc")],
    [drc.data, erc.data],
  );

  if (!projectId) return <EmptyState title="No project selected" />;
  const failed = drc.isError || erc.isError || drc.parseError || erc.parseError;
  const loading = drc.isLoading || erc.isLoading;
  const toolbar = (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
      <Button size="sm" disabled={tool.state.status === "running"} onClick={() => void tool.run("drc", { projectId })}>
        Run DRC
      </Button>
      <Button size="sm" disabled={tool.state.status === "running"} onClick={() => void tool.run("erc", { projectId })}>
        Run ERC
      </Button>
      {tool.state.status === "running" && <Spinner />}
      {tool.state.error && <span className="text-xs text-danger">{tool.state.error}</span>}
      <span className="ml-auto text-[11px] text-muted">
        {failed ? "Reports unavailable" : loading ? "Loading reports…" : drc.data === null && erc.data === null ? "no reports yet" : `${rows.length} finding${rows.length === 1 ? "" : "s"}`}
      </span>
    </div>
  );
  const sel = selected !== null ? rows[selected] : undefined;
  return (
    <div className="flex h-full flex-col">
      {toolbar}
      {!loading && !failed && <CheckReportStatus projectId={projectId} drc={drc.data} erc={erc.data} />}
      {failed ? <LoadError title="Checks could not be verified" onRetry={() => { void drc.refetch(); void erc.refetch(); }} /> : loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title={drc.data === null && erc.data === null ? "No DRC/ERC reports" : "No findings in saved reports"}>
          {drc.data === null && erc.data === null
            ? "Run DRC after routing; reports land in reports/drc.json and reports/erc.json."
            : "These saved reports contain no listed findings. Re-run checks after design changes; missing or incomplete checks do not establish a pass."}
        </EmptyState>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="fd-drc-table w-full text-left text-xs">
              <thead className="sticky top-0 bg-panel">
                <tr className="text-[10.5px] uppercase tracking-wide text-muted">
                  <th className="px-2 py-1.5">Src</th>
                  <th className="px-2 py-1.5">Severity</th>
                  <th className="px-2 py-1.5">Type</th>
                  <th className="px-2 py-1.5">Description</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v, i) => (
                  <tr
                    key={i}
                    onClick={() => setSelected(i)}
                    tabIndex={0}
                    aria-selected={selected === i}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(i); }
                    }}
                    className={cn("cursor-pointer border-t border-border/60 hover:bg-panel-2/60", selected === i && "bg-panel-2")}
                  >
                    <td className="px-2 py-1.5 font-mono uppercase text-muted">{v.source}</td>
                    <td className="px-2 py-1.5">
                      <Badge tone={v.severity === "error" ? "danger" : v.severity === "warning" ? "warning" : "neutral"}>{v.severity}</Badge>
                    </td>
                    <td className="px-2 py-1.5 font-mono">{v.type}</td>
                    <td className="px-2 py-1.5">{v.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sel && (
            <div className="max-h-48 overflow-auto border-t border-border bg-panel-2/40 px-3 py-2 text-xs">
              <div className="mb-1 font-medium">{sel.description}</div>
              {sel.items.length === 0 && <div className="text-muted">No item details.</div>}
              {sel.items.map((it, i) => (
                <div key={i} className="flex items-baseline gap-2">
                  {it.pos ? (
                    <span className="shrink-0 font-mono text-accent">
                      ({it.pos.x.toFixed(3)}, {it.pos.y.toFixed(3)}) mm
                    </span>
                  ) : (
                    <span className="shrink-0 font-mono text-muted">(no position)</span>
                  )}
                  <span>{it.description}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
