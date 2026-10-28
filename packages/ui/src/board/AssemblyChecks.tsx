import { Fragment, useState } from "react";
import type { BoardSourceSelection, ProjectBoardSources } from "@fabdesk/protocol";
import { normalizeReport, pcbToolJson, restoreAssemblySelection, useAssemblyPcbCheck, useRunTool } from "@fabdesk/client-core";
import { Badge, Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";

export function AssemblyChecks({ projectId, data, checking, failed, onRetry }: { projectId: string; data: ProjectBoardSources; checking: boolean; failed: boolean; onRetry: () => void }) {
  const [board, setBoard] = useState<BoardSourceSelection | null>(() => {
    const restored = restoreAssemblySelection(data, useUiStore.getState().assemblyBoardByProject[projectId]);
    return restored ? { sourceId: restored.sourceId, manifestSha256: restored.manifestSha256 } : null;
  });
  const [selected, setSelected] = useState<number | null>(null), [resultError, setResultError] = useState<string | null>(null), [runScope, setRunScope] = useState("");
  const source = data.sources.find(row => row.source.id === board?.sourceId);
  const owned = !!board && board.manifestSha256 === data.manifestSha256 && source?.status === "available" && source.source.location === "project";
  const report = useAssemblyPcbCheck(projectId, board, owned && !checking && !failed), tool = useRunTool(), busy = tool.state.status === "running";
  const scope = board ? `${board.sourceId}:${board.manifestSha256}` : "", rows = owned ? normalizeReport(report.data?.report, "drc") : [];
  const choose = (id: string) => { setBoard(id && data.manifestSha256 ? { sourceId: id, manifestSha256: data.manifestSha256 } : null); setSelected(null); setResultError(null); };
  const run = async () => {
    const snapshot = report.data;
    if (!board || !owned || !snapshot || report.isFetching || report.isError || checking || failed || busy || useUiStore.getState().activeProjectId !== projectId) return;
    setRunScope(scope); setResultError(null);
    const result = await tool.run("verify_drc", { projectId, board: { ...board }, expectedSourceSha256: snapshot.sourceSha256, schematicParity: false });
    if (result.status === "done") {
      try {
        const body = pcbToolJson(result.result), identity = body._board as Record<string, unknown> | undefined;
        if (identity?.projectId !== projectId || identity.sourceId !== board.sourceId || identity.manifestSha256 !== board.manifestSha256) throw new Error("The check result did not match this board source. Recheck sources before continuing.");
        setSelected(null); await report.refetch();
      } catch (error) { setResultError(error instanceof Error ? error.message : String(error)); }
    }
  };
  const status = report.data?.state;
  return <div className="fd-member-checks" data-testid="assembly-checks">
    <header><div><h2>Board checks</h2><p>Choose a source design to review its PCB checks. Boards sharing that design use the same report.</p></div>
      <label>Board source<select aria-label="Board source for checks" value={board?.sourceId ?? ""} disabled={busy || checking || failed} onChange={event => choose(event.target.value)}><option value="">Choose a board source…</option>{data.sources.map(row => <option key={row.source.id} value={row.source.id} disabled={row.status !== "available"}>{row.source.name}{row.status !== "available" ? " · unavailable" : ""}</option>)}</select></label>
    </header>
    <div className="fd-member-checks-toolbar"><Button size="sm" variant="ghost" disabled={busy || checking} onClick={() => { onRetry(); if (owned) void report.refetch(); }}>Recheck sources</Button>{owned && <Button size="sm" disabled={busy || checking || failed || report.isPending || report.isFetching || report.isError || !report.data} onClick={() => void run()}>{busy ? "Checking PCB…" : "Run PCB-only DRC"}</Button>}</div>
    {failed ? <LoadError title="Board sources could not be verified" onRetry={onRetry} /> : checking ? <p role="status"><Spinner />Checking project sources…</p> : !board ? <EmptyState title="Select a board to review its checks">Reports stay with their source design. No project-wide compatibility result is inferred.</EmptyState> : !owned ? <EmptyState title="Board source changed or is unavailable">Select the source again before checking it.<div className="mt-3"><Button size="sm" disabled={source?.status !== "available" || !data.manifestSha256} onClick={() => choose(board.sourceId)}>Select source again</Button></div></EmptyState> : <>
      <div className="fd-member-checks-scope"><strong>{source?.source.name}</strong><span>{data.assembly?.instances.filter(instance => instance.sourceId === board.sourceId).map(instance => instance.name).join(" · ")}</span><span>PCB-only · Schematic parity, ERC, inter-board connections and enclosure fit are not checked.</span></div>
      {report.isError ? <LoadError title="Could not verify this source’s report" onRetry={() => void report.refetch()} /> : report.isPending || report.isFetching ? <p role="status"><Spinner />Checking saved PCB and report…</p> : <>
        <p role="status" className="fd-member-checks-status" data-warning={status !== "source-unchanged"}>{status === "source-changed" ? "PCB changed since DRC · Findings below are from the older saved PCB." : status === "source-unchanged" ? "PCB unchanged since this report · Review the findings below." : status === "scope-unverified" ? "Saved report ownership is unverified · Run a new check for this source." : "No saved PCB check for this source."}</p>
        {report.data?.report ? rows.length ? <><p>{rows.length} saved findings</p><table className="fd-drc-table w-full text-left text-xs"><thead><tr><th>Severity</th><th>Rule</th><th>Description</th></tr></thead><tbody>{rows.map((row, index) => <Fragment key={index}><tr tabIndex={0} aria-selected={selected === index} onClick={() => setSelected(index)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelected(index); } }}><td><Badge tone={row.severity === "error" ? "danger" : row.severity === "warning" ? "warning" : "neutral"}>{row.severity}</Badge></td><td>{row.type}</td><td>{row.description}</td></tr>{selected === index && <tr><td colSpan={3}><section className="fd-member-checks-detail"><h3>{row.description}</h3>{row.items.map((item, itemIndex) => <p key={itemIndex}>{item.pos ? `(${item.pos.x.toFixed(3)}, ${item.pos.y.toFixed(3)}) mm · ` : ""}{item.description}</p>)}</section></td></tr>}</Fragment>)}</tbody></table></> : <EmptyState title="No findings listed in this report">This PCB-only report does not establish schematic parity or assembly compatibility.</EmptyState> : null}
      </>}
    </>}
    {runScope === scope && (resultError || tool.state.error) && <p role="alert" className="fd-update-feedback">{resultError ?? tool.state.error}</p>}
  </div>;
}
