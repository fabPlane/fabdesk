import type { ProjectBomSnapshot } from "@fabdesk/protocol";
import { bomOrigins, captureAssemblySourceSelection, useBoardSources } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { askAboutSurface } from "../chat/useAssistantSurface";
import { useUiStore } from "../stores/ui";
import "./bom-origins.css";

export function BomOrigins({ snapshot, open, onOpenChange, hardwareState, refreshFailed }: { snapshot: ProjectBomSnapshot; hardwareState: "loading" | "ok" | "error"; refreshFailed: boolean; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { projectId } = snapshot, sources = useBoardSources(projectId), summary = bomOrigins(snapshot);
  const hardwareError = hardwareState === "error";
  const current = () => useUiStore.getState().activeProjectId === projectId;
  return <section className="fd-bom-origins" aria-label="Included boards and hardware">
    <details open={open} onToggle={event => onOpenChange(event.currentTarget.open)}>
      <DisclosureSummary icon="pcb" label="Included boards and hardware" warning={summary.attention > 0 || hardwareError || refreshFailed} badge={`${summary.boards} ${summary.boards === 1 ? "board" : "boards"}${summary.hardwareParts ? ` · ${summary.hardwareParts} hardware parts` : ""}${summary.attention ? ` · ${summary.attention} ${summary.attention === 1 ? "design needs" : "designs need"} review` : ""}${hardwareError ? " · Hardware unreadable" : hardwareState === "loading" ? " · Reading hardware…" : ""}${refreshFailed ? " · Last read · Refresh failed" : ""}`} />
      <div className="fd-bom-origin-content">
      <p>Where this parts list comes from — design files and extra hardware, not suppliers.</p>
      <p>{summary.lines} {summary.lines === 1 ? "BOM line groups" : "BOM lines group"} {summary.mountedParts + summary.hardwareParts} listed parts per complete build. Build quantity multiplies these quantities.</p>
      {refreshFailed && <p className="fd-bom-origin-attention" role="status"><Icon name="warning" width={16} height={16} />Showing the last successful read. Use Refresh parts to try again; current files may have changed.</p>}
      {summary.attention > 0 && <p className="fd-bom-origin-attention" role="status"><Icon name="warning" width={16} height={16} />Listed quantities may be incomplete. Review the sources below, then refresh parts.</p>}
      <div className="fd-bom-origin-grid">{[...snapshot.coverage].sort((a, b) => Number(b.multiplier > 0 && b.status !== "native-schematic") - Number(a.multiplier > 0 && a.status !== "native-schematic")).map(source => {
        const native = source.status === "native-schematic", netlist = source.status === "saved-netlist", unused = source.multiplier === 0;
        const data = sources.data;
        const navigationReady = !sources.isFetching && !sources.isError && data?.projectId === projectId && (source.sourceId === null ? data.mode === "single" : data.mode === "assembly" && data.manifestSha256 === snapshot.manifestSha256 && !!captureAssemblySourceSelection(data, source.sourceId));
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
          <div className="fd-bom-origin-row">
            <Icon name="pcb" width={18} height={18} />
            <div className="fd-bom-origin-name"><strong>{source.name}</strong>
              <span>{unused ? "Not included" : native || netlist ? `${source.componentCount * source.multiplier} parts · ${source.multiplier} ${source.multiplier === 1 ? "board" : "boards"}${source.multiplier > 1 ? ` × ${source.componentCount} parts` : ""}` : `${source.multiplier} ${source.multiplier === 1 ? "board" : "boards"} · Parts unavailable`}</span>
            </div>
            <span className="fd-bom-origin-status" data-warning={!native && !unused}>{unused ? "Not counted" : native ? "Schematic read" : netlist ? "Saved netlist · Review source" : "Needs review"}</span>
            {!unused && <div className="fd-bom-origin-actions">
              {native && <Button size="sm" disabled={!navigationReady} title={navigationReady ? "Open this board’s schematic" : "Current board ownership must match this parts snapshot before opening its schematic"} onClick={openSchematic}><Icon name="schematic" width={15} height={15} />Open schematic</Button>}
              <Button size="sm" title={native || netlist ? `Ask about ${source.name} parts` : `Help recover ${source.name} parts`} aria-label={native || netlist ? `Ask about ${source.name} parts` : `Help recover ${source.name} parts`} onClick={() => { if (!current()) return; askAboutSurface({ projectId, label: `Parts / ${source.name}`, priority: 40, details: JSON.stringify({ source, manifestSha256: snapshot.manifestSha256, revision: snapshot.revision, capturedAt: snapshot.capturedAt, instruction: "Design-file origin and per-build quantities. Source reading is not a parity, electrical-check or supplier-stock result." }) }, native || netlist ? "Explain this board’s contribution to the parts list, including included components, exclusions and repeated board instances. Distinguish design quantities from supplier sourcing and check the current files before suggesting changes." : "Help recover this board’s parts list. Inspect its declared design files, explain what is missing or unreadable, and suggest the next step without guessing components or changing unrelated boards."); }}><Icon name="sparkles" width={15} height={15} />{native || netlist ? "Ask about parts" : "Get help"}</Button>
            </div>}
          </div>
          {!native && !unused && <p className="fd-bom-origin-reason">{netlist ? "Saved netlist only; schematic exclusions and freshness are unverified." : source.reason ?? "The saved design could not be read."}</p>}
          {!unused && <details><DisclosureSummary variant="compact" icon="folderOpen" label="Source files" />
            {native && <p>BOM exclusions from the schematic are respected.</p>}
            {source.sourceFiles?.length ? <ul>{source.sourceFiles.map(file => <li key={file.path}><button onClick={() => { if (current()) useUiStore.getState().openProjectFile(file.path); }} title={`Open ${file.path}`}>{file.path}</button></li>)}</ul> : <p>File details were not recorded in this snapshot. Refresh parts to read them again.</p>}
            <p>Read {new Date(snapshot.capturedAt).toLocaleString()}. Refresh parts after design changes.</p>
            {source.sourceRevision && <p className="fd-bom-origin-revision">Read revision: {source.sourceRevision}</p>}
          </details>}
        </article>;
      })}</div>
      <div className="fd-bom-origin-hardware"><Icon name="tool" width={17} height={17} /><strong>Extra hardware</strong><span>{hardwareError ? "Could not read project hardware" : hardwareState === "loading" ? "Reading project hardware…" : summary.hardwareParts ? `${summary.hardwareParts} parts per build · Counted once across all boards` : "None added"}</span></div>
      <p className="fd-bom-origin-note">Reading a source does not check PCB/schematic agreement, electrical correctness or supplier stock.</p>
      </div>
    </details>
  </section>;
}
