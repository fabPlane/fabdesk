import { useEffect, useRef, useState } from "react";
import type { ProjectBoardSources } from "@fabdesk/protocol";
import { LiveAssemblyPreviewQueue, restoreAssemblySelection, useAssemblyPreviewRevisions, useRunTool, type LiveAssemblyPreview } from "@fabdesk/client-core";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";

/** Only cheap, tracked PCB previews follow live saved changes; checks and heavy outputs remain independent. */
export function LiveAssemblyPreviews({ projectId, data, enabled }: { projectId: string; data: ProjectBoardSources; enabled: boolean }) {
  const queue = useRef(new LiveAssemblyPreviewQueue()), running = useRef(false), mounted = useRef(true);
  const previews = useAssemblyPreviewRevisions(projectId, data.sources), tool = useRunTool();
  const [notice, setNotice] = useState<{ target: LiveAssemblyPreview; status: "running" | "done" | "failed"; error?: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const latest = useRef({ data, previews, enabled }); latest.current = { data, previews, enabled };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const signature = JSON.stringify([data, enabled, previews.map(row => [row.sourceId, row.data, row.isFetching, row.isError])]);
  useEffect(() => {
    if (!enabled) return;
    queue.current.observe(data, previews);
    if (running.current) return;
    const timer = setTimeout(() => {
      const current = latest.current;
      if (!current.enabled || useUiStore.getState().activeProjectId !== projectId || running.current) return;
      const target = queue.current.next(current.previews); if (!target) return;
      running.current = true; setNotice({ target, status: "running" });
      void tool.run("render_pcb_svg", { projectId, board: { sourceId: target.selection.sourceId, manifestSha256: target.selection.manifestSha256 }, expectedSourceSha256: target.sourceSha256 }).then(result => {
        if (!mounted.current) return;
        setNotice({ target, status: result.status === "done" ? "done" : "failed", ...(result.error ? { error: result.error } : {}) });
      }).finally(() => { running.current = false; if (mounted.current) setRevision(value => value + 1); });
    }, 1200);
    return () => clearTimeout(timer);
  }, [signature, revision, projectId, tool.run]);
  if (!notice) return null;
  const selection = restoreAssemblySelection(data, notice.target.selection);
  const preview = previews.find(row => row.sourceId === notice.target.selection.sourceId);
  const source = selection ? data.sources.find(row => row.source.id === selection.sourceId) : undefined;
  const current = source?.pcbSha256 === notice.target.sourceSha256;
  const currentPreview = enabled && source?.status === "available" && preview?.data === "matches-source" && !preview.isFetching && !preview.isError;
  const verified = current && currentPreview;
  const superseded = notice.status !== "running" && !current && currentPreview;
  const canView = notice.status === "done" && verified || superseded;
  return <div className="fd-live-preview-notice" role="status"><Icon name={notice.status === "failed" && !superseded ? "warning" : "pcb"} width={16} height={16} /><span>{superseded ? `${notice.target.name} preview matches PCB · older update skipped` : notice.status === "running" ? `Updating ${notice.target.name} preview…` : notice.status === "failed" ? current ? `${notice.target.name} preview needs review` : `${notice.target.name} earlier preview update failed · source changed` : verified ? `${notice.target.name} preview updated` : current ? `${notice.target.name} preview rendered · checking source` : `${notice.target.name} preview update finished · source changed`}</span>
    {notice.status !== "running" && <Button size="sm" variant="ghost" disabled={!enabled} title={superseded ? "The current preview matches the saved PCB. An older preview update was skipped." : notice.error} onClick={() => { const ui = useUiStore.getState(); if (ui.activeProjectId !== projectId) return; if (canView && selection) { const preferred = restoreAssemblySelection(data, ui.assemblyBoardByProject[projectId]); ui.setAssemblyBoard(preferred?.sourceId === selection.sourceId ? preferred : selection); ui.setBoardTab("pcb"); } else ui.setBoardTab("updates"); }}>{canView ? "View" : "Review"}</Button>}
    <button className="fd-assembly-dismiss" aria-label="Dismiss preview activity" onClick={event => { const workspace = event.currentTarget.closest(".fd-canvas-workspace"); const target = workspace?.querySelector<HTMLElement>(".fd-svg-host[tabindex]") ?? workspace?.querySelector<HTMLElement>(".fd-assembly-viewport") ?? workspace?.querySelector<HTMLElement>(".fd-canvas-destinations summary"); setNotice(null); requestAnimationFrame(() => target?.focus({ preventScroll: true })); }}><Icon name="close" width={14} height={14} /></button>
  </div>;
}
