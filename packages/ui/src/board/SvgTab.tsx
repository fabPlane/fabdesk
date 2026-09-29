import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useProject, useProjectText } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { SvgViewer } from "./SvgViewer";
import { useRunTool } from "@fabdesk/client-core";

const RENDER_TOOL = { schematic: "render_schematic_svg", pcb: "render_pcb_svg" } as const;

function BoardOutline() {
  return <svg width="100" height="76" viewBox="0 0 100 76" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
    <rect x="10" y="8" width="80" height="60" rx="8" opacity=".5" />
    <rect x="39" y="25" width="22" height="26" rx="3" />
    <path d="M44 19v6m12-6v6M44 51v6m12-6v6M33 32h6m-6 12h6m22-12h6m-6 12h6M10 28h12l9 10h8M61 38h12l10-10h7" opacity=".6" />
    <circle cx="19" cy="17" r="2" /><circle cx="81" cy="59" r="2" />
  </svg>;
}

export function svgArtifactCopy(kind: "schematic" | "pcb") {
  const label = kind === "pcb" ? "PCB" : "schematic";
  return {
    label,
    title: `No ${label} SVG render yet`,
    action: `Render ${label} SVG`,
  };
}

/** Schematic / PCB tab: shows the daemon's rendered SVG (`renders/<kind>.svg`, drawn by kicad-cli) and offers to render it. */
export function SvgTab({ kind }: { kind: "schematic" | "pcb" }) {
  const projectId = useUiStore((s) => s.activeProjectId);
  const project = useProject(projectId);
  const rendered = useProjectText(projectId, `renders/${kind}.svg`);
  const render = useRunTool();

  if (!projectId)
    return (
      <div className="fd-canvas-empty h-full"><EmptyState title="Your board starts here" icon={<BoardOutline />}>
        Pick a project in the sidebar to see its {kind}.
      </EmptyState></div>
    );
  if (project.isLoading) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  if (project.isError) return <LoadError title="Could not load project files" onRetry={() => void project.refetch()} />;
  if (rendered.isError) return <LoadError title="Could not load board preview" onRetry={() => void rendered.refetch()} />;
  if (rendered.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (rendered.data) {
    return (
      <div className="h-full" data-testid={`board-${kind}-svg`}>
        <SvgViewer
          svg={rendered.data}
          toolbar={<span className="text-[11px] text-muted">renders/{kind}.svg</span>}
        />
      </div>
    );
  }
  const sourcePath = kind === "pcb" ? "board.kicad_pcb" : "board.kicad_sch";
  if (!project.data?.files.some((file) => file.path === sourcePath))
    return <div className="fd-canvas-empty h-full" data-testid={`board-${kind}-missing-source`}><EmptyState title={kind === "pcb" ? "No KiCad board found" : "No KiCad schematic found"} icon={<BoardOutline />}>
      {kind === "pcb" ? "Add a KiCad board to this project to preview it here." : "Add a KiCad schematic to this project to preview it here."}
    </EmptyState></div>;
  const running = render.state.status === "running";
  const copy = svgArtifactCopy(kind);
  return (
    <div className="fd-canvas-empty h-full" data-testid={`board-${kind}-empty`}>
      <EmptyState
        title={copy.title}
        icon={<BoardOutline />}
        action={
          <Button
            variant="primary"
            size="sm"
            disabled={running}
            onClick={() => void render.run(RENDER_TOOL[kind], { projectId })}
          >
            {running ? "Rendering..." : copy.action}
          </Button>
        }
      >
        {kind === "pcb"
          ? "Generate a preview from your saved PCB to inspect the layout. Image exports are available in Renders."
          : "Generate a preview from your saved KiCad schematic to inspect the circuit alongside your conversation."}
        {render.state.error && <div className="mt-2 text-danger">{render.state.error}</div>}
      </EmptyState>
    </div>
  );
}
