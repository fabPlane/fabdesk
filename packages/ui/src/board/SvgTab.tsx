import { Button, EmptyState, Spinner } from "../components/ui";
import { useProjectText } from "../hooks/queries";
import { useUiStore } from "../stores/ui";
import { SvgViewer } from "./SvgViewer";
import { useRunTool } from "./tools";

const RENDER_TOOL = { schematic: "render_schematic_svg", pcb: "render_pcb_svg" } as const;

/** Schematic / PCB tab: shows the daemon's rendered SVG (`renders/<kind>.svg`, drawn by kicad-cli) and offers to render it. */
export function SvgTab({ kind }: { kind: "schematic" | "pcb" }) {
  const projectId = useUiStore((s) => s.activeProjectId);
  const rendered = useProjectText(projectId, `renders/${kind}.svg`);
  const render = useRunTool();

  if (!projectId) return <EmptyState title="No project selected">Pick a project in the sidebar to see its {kind}.</EmptyState>;
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
        <SvgViewer svg={rendered.data} toolbar={<span className="text-[11px] text-muted">renders/{kind}.svg</span>} />
      </div>
    );
  }
  const running = render.state.status === "running";
  return (
    <div className="h-full" data-testid={`board-${kind}-empty`}>
      <EmptyState
        title={`No ${kind} render yet`}
        action={
          <Button variant="primary" size="sm" disabled={running} onClick={() => void render.run(RENDER_TOOL[kind], { projectId })}>
            {running ? "Rendering..." : `Render ${kind}`}
          </Button>
        }
      >
        {kind === "pcb"
          ? "Build the board (circuit_build) and render it, or ask the agent to design one."
          : "A compiled project has no drawn schematic; import a KiCad project to see one here."}
        {render.state.error && <div className="mt-2 text-danger">{render.state.error}</div>}
      </EmptyState>
    </div>
  );
}
