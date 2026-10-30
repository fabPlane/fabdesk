import { useEffect, useState } from "react";
import { assemblyFindingPreviewMatches, useCoreClient, usePcbCheckRevision, useProjectJson, useProjectText } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { askAboutSurface } from "../chat/useAssistantSurface";
import { SavedFindingOverlay } from "./SavedFindingOverlay";
import { svgPointToPercent, type SvgBox } from "./svg-coords";

/** A saved finding is navigation evidence, never an editing selection or a new comment. */
export function RootFindingOverlay({ projectId, svg, box, ready }: { projectId: string; svg: string; box: SvgBox | null; ready: boolean }) {
  const client = useCoreClient();
  const candidate = useUiStore(state => state.rootFinding);
  const finding = candidate?.projectId === projectId && candidate.endpoint === client.baseUrl ? candidate : null;
  const report = useProjectJson(projectId, finding ? "reports/drc.json" : null);
  const receipt = useProjectText(projectId, finding ? "renders/pcb.svg.revision.json" : null);
  const check = usePcbCheckRevision(projectId, !!finding);
  const [verified, setVerified] = useState<{ svg: string; receipt: string; sha: string } | null>(null);
  useEffect(() => {
    let alive = true;
    if (finding && receipt.data) {
      const text = receipt.data, sha = finding.sourceSha256;
      void assemblyFindingPreviewMatches(svg, text, sha).then(matches => {
        if (alive) setVerified(matches ? { svg, receipt: text, sha } : null);
      }).catch(() => { if (alive) setVerified(null); });
    }
    return () => { alive = false; };
  }, [svg, receipt.data, finding?.sourceSha256]);
  if (!finding) return null;
  const checking = report.isFetching || receipt.isFetching || check.isFetching;
  const current = ready && !checking && !report.isError && !report.parseError && !receipt.isError && !check.isError && check.data === "source-unchanged" && JSON.stringify(report.data) === finding.reportFingerprint && verified?.svg === svg && verified.receipt === receipt.data && verified.sha === finding.sourceSha256;
  const position = current && box ? svgPointToPercent(box, finding.point) : null;
  const visible = position && position.left >= 0 && position.left <= 100 && position.top >= 0 && position.top <= 100;
  return <SavedFindingOverlay description={finding.description} point={finding.point} position={visible ? position : null} outside={!!current && !visible} focusKey={finding} canFocus={() => {
    const ui = useUiStore.getState(); return ui.activeProjectId === projectId && ui.rootFinding === finding;
  }} detail={current ? `${finding.point.x.toFixed(3)}, ${finding.point.y.toFixed(3)} mm · ${finding.itemDescription}` : checking ? "Checking saved finding and drawing…" : "Finding or drawing changed or is unverified. Marker hidden; review checks again."}>
      <Button size="sm" disabled={!current} onClick={() => {
        const ui = useUiStore.getState();
        if (ui.activeProjectId !== projectId || ui.rootFinding !== finding) return;
        askAboutSurface({ projectId, label: "PCB / Saved finding", priority: 25, details: JSON.stringify({ source: "board.kicad_pcb", report: "reports/drc.json", finding: { description: finding.description, item: finding.itemDescription, pointMm: finding.point, recordedSourceSha256: finding.sourceSha256 }, locationVerified: !!visible, instruction: "Inspect latest saved source and report before explaining whether this finding still applies. Explain the cause and proposed fix before changing the design." }) }, `Explain this PCB finding: ${finding.description}. What should I check before fixing it?`);
      }}>Ask about finding</Button><Button size="sm" variant="ghost" onClick={() => useUiStore.getState().setBoardTab("drc")}>Back to checks</Button><Button size="sm" variant="ghost" onClick={event => {
        const drawing = event.currentTarget.closest('[data-testid="board-pcb-svg"]')?.querySelector<HTMLElement>('[aria-label^="Drawing canvas"]') ?? event.currentTarget.closest('[data-testid="board-pcb-svg"]')?.querySelector<HTMLElement>('[data-testid="comment-mode"]');
        useUiStore.getState().dismissRootFinding(); requestAnimationFrame(() => drawing?.focus());
      }}>Dismiss finding</Button>
  </SavedFindingOverlay>;
}
