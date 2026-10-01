import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useProject } from "@fabdesk/client-core";
import { useRunsStore } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { useRunTool } from "@fabdesk/client-core";

const GLB_PATH = "renders/board.glb";

/**
 * 3D tab placeholder: a real viewer (three.js / model-viewer) is deferred to M13. This tab renders the
 * GLB via the `render_glb` tool and reports where the file landed.
 */
export function ThreeDTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const glb = project.data?.files.find((f) => f.path === GLB_PATH);
  const { run, state } = useRunTool();
  const job = useRunsStore((s) => (state.jobId ? s.jobs[state.jobId] : undefined));

  if (!projectId) return <EmptyState title="No project selected" />;
  if (project.isError) return <LoadError title="Could not load 3D export" onRetry={() => void project.refetch()} />;
  if (project.isLoading) return <EmptyState title="Loading 3D export"><Spinner /></EmptyState>;
  return (
    <EmptyState
      title={glb ? "3D model ready to export" : "Export a 3D model"}
      action={
        <Button variant="primary" size="sm" disabled={state.status === "running"} onClick={() => void run("glb", { projectId })}>
          {state.status === "running" ? (
            <>
              <Spinner className="mr-1" /> Rendering...
            </>
          ) : glb ? (
            "Regenerate 3D model"
          ) : (
            "Generate 3D model"
          )}
        </Button>
      }
    >
      {glb ? (
        <div>
          <div className="font-mono text-[11px]">{GLB_PATH}</div>
          <div>
            {(glb.size / 1024).toFixed(0)} KB, updated {new Date(glb.mtime).toLocaleString()}
          </div>
          <div className="mt-1">Open this GLB file in a compatible 3D viewer. This tab exports models; it does not display an interactive preview.</div>
        </div>
      ) : (
        "Create a GLB file for a compatible 3D viewer. For board preview images, open Renders."
      )}
      {job?.note && <div className="mt-2 text-muted">{job.note}</div>}
      {state.error && <div className="mt-2 text-danger">{state.error}</div>}
    </EmptyState>
  );
}
