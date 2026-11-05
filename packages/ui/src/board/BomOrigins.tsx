import type { ProjectBomSnapshot } from "@fabdesk/protocol";
import { bomOrigins, captureAssemblySourceSelection, useBoardSources } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { askAboutSurface } from "../chat/useAssistantSurface";
import { useUiStore } from "../stores/ui";
import "./bom-origins.css";

export function BomOrigins({ snapshot }: { snapshot: ProjectBomSnapshot }) {
  const { projectId } = snapshot, sources = useBoardSources(projectId), summary = bomOrigins(snapshot);
  const current = () => useUiStore.getState().activeProjectId === projectId;
  return <section className="fd-bom-origins" aria-label="Included boards and hardware">
    {summary.attention > 0 && <p className="fd-bom-origin-attention" role="status"><Icon name="warning" width={16} height={16} />{summary.attention} of {summary.designs} board designs need attention. Quantities may be incomplete; use Refresh parts after resolving the files below.</p>}
    <details>
      <DisclosureSummary variant="compact" icon="pcb" label="Included boards & hardware" warning={summary.attention > 0} badge={`${summary.boards} ${summary.boards === 1 ? "board" : "boards"} · ${summary.hardwareParts} hardware parts`} />
      <p>This parts list comes from your saved design files and project hardware. Supplier part numbers and purchasing availability are separate.</p>
      <p className="fd-bom-origin-quantities"><strong>{summary.lines} BOM {summary.lines === 1 ? "line" : "lines"}</strong> contain <strong>{summary.mountedParts} on-board parts</strong> and <strong>{summary.hardwareParts} hardware parts</strong> per complete build. Build quantity multiplies these per-build quantities.</p>
      <div className="fd-bom-origin-grid">{snapshot.coverage.map(source => {
        const native = source.status === "native-schematic", netlist = source.status === "saved-netlist", unused = source.multiplier === 0;
        const data = sources.data, declared = data?.sources.find(row => row.source.id === source.sourceId);
        const navigationReady = !sources.isFetching && !sources.isError && !!data && (source.sourceId === null ? data.mode === "single" : data.mode === "assembly" && data.manifestSha256 === snapshot.manifestSha256 && declared?.status === "available");
        const openSchematic = () => {
          if (!current() || !navigationReady || !data) return;
          const ui = useUiStore.getState();
          if (data.mode === "assembly" && source.sourceId) {
            const selection = captureAssemblySourceSelection(data, source.sourceId, ui.assemblyBoardByProject[projectId]);
            if (!selection) return;
            ui.setAssemblyBoard(selection);
          }
          ui.setBoardTab("schematic");
        };
        return <article key={source.sourceId ?? "root"} data-attention={!native && !unused}>
          <strong>{source.name}</strong>
          <p>{unused ? "Not included in this build — no board instances declared." : native || netlist ? `${source.componentCount} included components × ${source.multiplier} ${source.multiplier === 1 ? "board" : "boards"} = ${source.componentCount * source.multiplier} parts per build.` : `${source.multiplier} ${source.multiplier === 1 ? "board is" : "boards are"} affected; its parts could not be fully listed.`}</p>
          <p>{native ? "Read from the saved schematic; BOM exclusions respected." : netlist ? "Read from a saved design netlist. Schematic exclusions and freshness are not verified." : source.reason ?? "The saved design could not be read."}</p>
          {!unused && <div className="fd-bom-origin-actions">
            {native && <Button size="sm" disabled={!navigationReady} title={navigationReady ? "Open this board’s schematic" : "Current board ownership must match this parts snapshot before opening its schematic"} onClick={openSchematic}><Icon name="schematic" width={15} height={15} />Open schematic</Button>}
            <Button size="sm" onClick={() => { if (!current()) return; askAboutSurface({ projectId, label: `Parts / ${source.name}`, priority: 40, details: JSON.stringify({ source, manifestSha256: snapshot.manifestSha256, revision: snapshot.revision, capturedAt: snapshot.capturedAt, instruction: "Design-file origin and per-build quantities. Source reading is not a parity, electrical-check or supplier-stock result." }) }, native || netlist ? "Explain this board’s contribution to the parts list, including included components, exclusions and repeated board instances. Distinguish design quantities from supplier sourcing and check the current files before suggesting changes." : "Help recover this board’s parts list. Inspect its declared design files, explain what is missing or unreadable, and suggest the next step without guessing components or changing unrelated boards."); }}><Icon name="sparkles" width={15} height={15} />{native || netlist ? "Ask about included parts" : "Help recover parts"}</Button>
          </div>}
          {!unused && <details><DisclosureSummary variant="compact" icon="folderOpen" label="Design files & read details" />
            {source.sourceFiles?.length ? <ul>{source.sourceFiles.map(file => <li key={file.path}><button onClick={() => { if (current()) useUiStore.getState().openProjectFile(file.path); }} title={`Open ${file.path}`}>{file.path}</button></li>)}</ul> : <p>File details were not recorded in this snapshot. Refresh parts to read them again.</p>}
            <p>Read {new Date(snapshot.capturedAt).toLocaleString()}. Refresh parts after design changes.</p>
            {source.sourceRevision && <p className="fd-bom-origin-revision">Read revision: {source.sourceRevision}</p>}
          </details>}
        </article>;
      })}</div>
      <p>Project hardware is counted once per build, even when several boards share one design. Reading the files does not establish PCB–schematic consistency, passed electrical checks or supplier availability.</p>
    </details>
  </section>;
}
