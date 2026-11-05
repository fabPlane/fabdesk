import { lazy, Suspense } from "react";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { ProjectImage } from "../chat/ProjectImage";
import { ProjectVideo } from "../chat/ProjectVideo";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { Dialog, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { basename } from "../util";
import { VideoSourceStatus } from "./VideoSourceStatus";
import { BoardModelExportDetails } from "./BoardModelExportDetails";
import { MemberModelExportDetails } from "./MemberModelExportDetails";

const ModelCanvas = lazy(() => import("./ModelCanvas"));
export type PreviewOutput = { path: string; kind: "images" | "videos" | "models"; sourceId?: string; sourceName?: string };

/** The same saved-media viewer from Library and Review; closing restores the caller's page. */
export function OutputPreviewDialog({ projectId, output, status, warning = false, onClose }: {
  projectId: string;
  output: PreviewOutput;
  status: string;
  warning?: boolean;
  onClose: () => void;
}) {
  const surface = { projectId, label: `Output preview · ${basename(output.path)}`, priority: 40,
    details: JSON.stringify({ view: "Saved output preview", preview: { ...output, status }, instruction: "Inspect the saved file and its recorded inputs. Output freshness does not establish electrical checks or physical compatibility." }) };
  useAssistantSurface(surface);
  return <Dialog open onClose={onClose} title={output.sourceName ? `${output.sourceName} · ${basename(output.path)}` : basename(output.path)} className="fd-output-preview-dialog" headerActions={<>
      <CanvasToolButton icon="folderOpen" label="Show file" onClick={() => {
        if (useUiStore.getState().activeProjectId !== projectId) return;
        onClose(); useUiStore.getState().openProjectFile(output.path);
      }} />
      <CanvasToolButton icon="sparkles" label="Ask about this output" onClick={() => {
        askAboutSurface(surface, `Help me review ${basename(output.path)}. Explain what it shows and whether its saved inputs need attention.`); onClose();
      }} />
    </>}>
    {output.kind !== "videos" && <p className="fd-output-preview-source" role="status" data-warning={warning}>{status}</p>}
    {output.kind === "models" && output.sourceId ? <MemberModelExportDetails projectId={projectId} sourceId={output.sourceId} path={output.path} /> : output.path === "renders/board.glb" ? <BoardModelExportDetails projectId={projectId} /> : null}
    {output.kind === "images" ? <ProjectImage retryable projectId={projectId} path={output.path} className="max-h-[70vh] w-full object-contain" />
      : output.kind === "videos" ? <><VideoSourceStatus projectId={projectId} path={output.path} updating={false} /><ProjectVideo projectId={projectId} path={output.path} className="max-h-[70vh]" /></>
      : <div className="fd-output-model-preview"><Suspense fallback={<Spinner />}><ModelCanvas projectId={projectId} path={output.path} /></Suspense></div>}
  </Dialog>;
}
