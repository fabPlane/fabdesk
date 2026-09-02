import { Button, EmptyState, Spinner } from "../components/ui";
import { useProject } from "../hooks/queries";
import { useRunsStore } from "../stores/runs";
import { useUiStore } from "../stores/ui";
import { useRunTool } from "./tools";

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
  return (
    <EmptyState
      title={glb ? "3D model rendered" : "No 3D model yet"}
      action={
        <Button variant="primary" size="sm" disabled={state.status === "running"} onClick={() => void run("glb", { projectId })}>
          {state.status === "running" ? (
            <>
              <Spinner className="mr-1" /> Rendering...
            </>
          ) : glb ? (
            "Re-render 3D"
          ) : (
            "Render 3D"
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
          <div className="mt-1">Open the file in any glTF viewer; the in-app 3D viewer arrives with the simulation milestone.</div>
        </div>
      ) : (
        "Renders the routed board to renders/board.glb with KiCad."
      )}
      {job?.note && <div className="mt-2 text-muted">{job.note}</div>}
      {state.error && <div className="mt-2 text-danger">{state.error}</div>}
    </EmptyState>
  );
}
