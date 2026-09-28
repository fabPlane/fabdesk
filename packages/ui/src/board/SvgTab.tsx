import { Button, EmptyState, Spinner } from "../components/ui";
import { useProjectText } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { SvgViewer } from "./SvgViewer";
import { useRunTool } from "@fabdesk/client-core";

const RENDER_TOOL = { schematic: "render_schematic_svg", pcb: "render_pcb_svg" } as const;

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
  const rendered = useProjectText(projectId, `renders/${kind}.svg`);
  const render = useRunTool();

  if (!projectId)
    return (
      <EmptyState title="No project selected">
        Pick a project in the sidebar to see its {kind}.
      </EmptyState>
    );
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
  const running = render.state.status === "running";
  const copy = svgArtifactCopy(kind);
  return (
    <div className="h-full" data-testid={`board-${kind}-empty`}>
      <EmptyState
        title={copy.title}
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
          ? "This tab displays renders/pcb.svg. Build the board, then generate its PCB SVG; PNG images appear under Renders."
          : "This tab displays renders/schematic.svg generated from the saved native KiCad schematic."}
        {render.state.error && <div className="mt-2 text-danger">{render.state.error}</div>}
      </EmptyState>
    </div>
  );
}
