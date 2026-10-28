import { useMemo, useState } from "react";
import { Badge, Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { captureRootCheckFinding, useCoreClient, usePcbCheckRevision, useProjectJson } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { CheckReportStatus } from "./CheckReportStatus";
import { cn } from "../util";
import { useRunTool } from "@fabdesk/client-core";

import { normalizeReport, useBoardSources, useProject } from "@fabdesk/client-core";
import { AssemblyChecks } from "./AssemblyChecks";
export { normalizeReport, type Violation, type ViolationItem } from "@fabdesk/client-core";

export function DrcTab() {
  const projectId = useUiStore(state => state.activeProjectId), sources = useBoardSources(projectId);
  if (!projectId) return <EmptyState title="No project selected" />;
  if (sources.isPending) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (sources.isError && sources.data?.mode !== "assembly") return <LoadError title="Could not verify project board sources" onRetry={() => { void sources.refetch(); }} />;
  if (sources.data?.mode === "assembly") return <AssemblyChecks projectId={projectId} data={sources.data} checking={sources.isFetching} failed={sources.isError} onRetry={() => { void sources.refetch(); }} />;
  return <SingleBoardChecks key={projectId} projectId={projectId} scopeVerified={sources.data?.mode === "single" && !sources.isFetching && !sources.isError} />;
}

function SingleBoardChecks({ projectId, scopeVerified }: { projectId: string; scopeVerified: boolean }) {
  const project = useProject(projectId);
  const client = useCoreClient();
  const drc = useProjectJson(projectId, "reports/drc.json");
  const erc = useProjectJson(projectId, "reports/erc.json");
  const checkRevision = usePcbCheckRevision(projectId, !!drc.data);
  const [selected, setSelected] = useState<number | null>(null);
  const [filter, setFilter] = useState<"all" | "drc" | "erc">("all");
  const [runningCheck, setRunningCheck] = useState<"drc" | "erc" | null>(null);
  const tool = useRunTool();
  const rows = useMemo(
    () => [...normalizeReport(drc.data, "drc"), ...normalizeReport(erc.data, "erc")],
    [drc.data, erc.data],
  );

  const busy = tool.state.status === "running";
  const sourceReady = scopeVerified && !!project.data && !project.isFetching && !project.isError;
  const hasPcb = !!project.data?.files.some(file => file.path === "board.kicad_pcb");
  const hasSchematic = !!project.data?.files.some(file => file.path === "board.kicad_sch");
  const run = async (kind: "drc" | "erc") => {
    if (busy || !sourceReady || !(kind === "drc" ? hasPcb : hasSchematic) || useUiStore.getState().activeProjectId !== projectId) return;
    setRunningCheck(kind);
    const result = await tool.run(kind, { projectId, ...(kind === "drc" && !hasSchematic ? { schematicParity: false } : {}) });
    if (result.status === "done") { setSelected(null); await Promise.all([drc.refetch(), erc.refetch()]); }
  };
  const filteredRows = rows.map((finding, index) => ({ finding, index })).filter(({ finding }) => filter === "all" || finding.source === filter);
  const failed = drc.isError || erc.isError || drc.parseError || erc.parseError;
  const loading = drc.isLoading || erc.isLoading;
  const noReports = drc.data === null && erc.data === null;
  const toolbar = (
    <header className="fd-single-checks-header">
      <div><h2>Design checks</h2><p>Check the saved PCB and schematic. Review findings after each design change.</p></div>
      <div className="fd-single-checks-actions">
        <Button size="sm" disabled={busy || !sourceReady || !hasPcb} title={!hasPcb ? "Save a native PCB before running DRC" : !hasSchematic ? "Check PCB design rules only; schematic parity is unavailable" : "Check PCB design rules and available schematic parity"} onClick={() => void run("drc")}>
          {busy && runningCheck === "drc" ? "Checking PCB…" : hasSchematic ? "Run PCB checks" : "Run PCB-only checks"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy || !sourceReady || !hasSchematic} title={!hasSchematic ? "Save a native schematic before running ERC" : "Check the complete saved schematic hierarchy"} onClick={() => void run("erc")}>
          {busy && runningCheck === "erc" ? "Checking schematic…" : "Run schematic checks"}
        </Button>
        {busy && <Spinner />}
      </div>
      {project.isError ? <LoadError title="Could not inspect saved design files" onRetry={() => void project.refetch()} /> : !sourceReady ? <p role="status">Checking project sources…</p> : (!hasPcb || !hasSchematic) && <p className="fd-single-checks-prerequisite">{!hasPcb && !hasSchematic ? "Save a PCB or schematic to start checking your design." : !hasSchematic ? "No saved schematic yet. PCB checks are available; electrical rule checking needs a schematic." : "No saved PCB yet. Schematic checks are available; PCB design rules need a board."}</p>}
      {tool.state.error && <p role="alert" className="text-xs text-danger">{tool.state.error}</p>}
      {!loading && !failed && !noReports && <div className="fd-single-checks-filter"><label>Findings<select aria-label="Filter saved check findings" value={filter} onChange={event => { setFilter(event.target.value as typeof filter); setSelected(null); }}><option value="all">All checks</option><option value="drc">PCB · DRC</option><option value="erc">Schematic · ERC</option></select></label><span>{filteredRows.length} of {rows.length} saved findings</span></div>}
    </header>
  );
  const sel = selected !== null ? rows[selected] : undefined;
  return (
    <div className="fd-single-checks flex h-full min-h-0 flex-col">
      {toolbar}
      {!loading && !failed && !noReports && <CheckReportStatus projectId={projectId} drc={drc.data} erc={erc.data} />}
      {failed ? <LoadError title="Checks could not be verified" onRetry={() => { void drc.refetch(); void erc.refetch(); }} /> : loading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : filteredRows.length === 0 ? (
        <EmptyState title={noReports ? "Start with a design check" : rows.length > 0 ? "No findings in this view" : "No findings in saved reports"}>
          {noReports
            ? "PCB checks (DRC) look for layout problems such as clearances and unconnected pads. Schematic checks (ERC) look for electrical connection problems. Choose a check above when its source is ready."
            : rows.length > 0 ? "Choose All checks to see the other saved findings." : "These saved reports contain no listed findings. Re-run checks after design changes; missing or incomplete checks do not establish a pass."}
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
                {filteredRows.map(({ finding: v, index: i }) => (
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
              <div className="mb-1 flex items-start justify-between gap-3"><strong>{sel.description}</strong><Button size="sm" variant="ghost" onClick={() => setSelected(null)}>Close details</Button></div>
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
                  {sel.source === "drc" && selected !== null && captureRootCheckFinding(client.baseUrl, projectId, drc.data, selected, i) && <Button size="sm" variant="ghost" disabled={!sourceReady || busy || drc.isFetching || drc.isError || checkRevision.isFetching || checkRevision.isError || checkRevision.data !== "source-unchanged"} onClick={() => {
                    const state = useUiStore.getState(); if (state.activeProjectId !== projectId || !sourceReady || busy || drc.isFetching || checkRevision.isFetching || checkRevision.isError || checkRevision.data !== "source-unchanged") return;
                    const finding = captureRootCheckFinding(client.baseUrl, projectId, drc.data, selected, i);
                    if (finding) state.openRootFinding(finding);
                  }}>Show on PCB</Button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
