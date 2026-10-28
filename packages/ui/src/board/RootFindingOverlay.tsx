import { useEffect, useRef, useState } from "react";
import { assemblyFindingPreviewMatches, useCoreClient, usePcbCheckRevision, useProjectJson, useProjectText } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { newChatDraftKey, useUiStore } from "../stores/ui";
import { svgPointToPercent, type SvgBox } from "./svg-coords";

/** A saved finding is navigation evidence, never an editing selection or a new comment. */
export function RootFindingOverlay({ projectId, svg, box, ready }: { projectId: string; svg: string; box: SvgBox | null; ready: boolean }) {
  const client = useCoreClient();
  const candidate = useUiStore(state => state.rootFinding);
  const finding = candidate?.projectId === projectId && candidate.endpoint === client.baseUrl ? candidate : null;
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = card.current;
    if (!finding || !element) return;
    // The SVG host starts hidden until its image loads. Focus only once it is painted.
    const focus = () => {
      if (!element.getClientRects().length) return;
      observer.disconnect();
      const ui = useUiStore.getState();
      if (ui.activeProjectId === projectId && ui.rootFinding === finding && document.activeElement === document.body) element.focus({ preventScroll: true });
    };
    const observer = new ResizeObserver(focus);
    observer.observe(element);
    const frame = requestAnimationFrame(focus);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [finding, projectId]);
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
  return <div className="fd-root-finding-overlay" data-canvas-tools>
    {visible && <div className="fd-root-finding-marker" role="img" aria-label={`Saved PCB finding at ${finding.point.x}, ${finding.point.y} mm`} style={{ left: `${position.left}%`, top: `${position.top}%` }}><span /></div>}
    <section ref={card} tabIndex={-1} className="fd-root-finding-card" style={position && position.top > 50 ? { top: 14, bottom: "auto" } : undefined} aria-label="Selected saved PCB finding">
      <strong>{finding.description}</strong>
      <p>{current ? `${finding.point.x.toFixed(3)}, ${finding.point.y.toFixed(3)} mm · ${finding.itemDescription}` : checking ? "Checking saved finding and drawing…" : "Finding or drawing changed or is unverified. Marker hidden; review checks again."}</p>
      {current && !visible && <p>This reported position lies outside the displayed drawing.</p>}
      <div><Button size="sm" disabled={!current} onClick={() => {
        const ui = useUiStore.getState();
        if (ui.activeProjectId !== projectId || ui.rootFinding !== finding) return;
        const key = ui.activeThreadId ?? newChatDraftKey(projectId);
        const prompt = `Help me understand this saved PCB check finding: ${JSON.stringify(finding.description)}. Report item: ${JSON.stringify(finding.itemDescription)} at X ${finding.point.x} mm, Y ${finding.point.y} mm. It was recorded in reports/drc.json for board.kicad_pcb SHA-256 ${finding.sourceSha256}. Inspect the latest saved sources and report before explaining whether it still applies. Explain the cause and proposed fix before making changes.`;
        const previous = ui.drafts[key] ?? "";
        ui.setDraft(key, previous.trim() ? `${previous}\n\n${prompt}` : prompt);
        ui.focusComposer();
      }}>Ask about finding</Button><Button size="sm" variant="ghost" onClick={() => useUiStore.getState().setBoardTab("drc")}>Back to checks</Button><Button size="sm" variant="ghost" onClick={event => {
        const drawing = event.currentTarget.closest('[data-testid="board-pcb-svg"]')?.querySelector<HTMLElement>('[aria-label^="Drawing canvas"]') ?? event.currentTarget.closest('[data-testid="board-pcb-svg"]')?.querySelector<HTMLElement>('[data-testid="comment-mode"]');
        useUiStore.getState().dismissRootFinding(); requestAnimationFrame(() => drawing?.focus());
      }}>Dismiss finding</Button></div>
    </section>
  </div>;
}
