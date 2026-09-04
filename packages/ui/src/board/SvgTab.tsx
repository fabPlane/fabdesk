import { useEffect, useState } from "react";
import { Button, EmptyState, Spinner } from "../components/ui";
import { useProjectJson, useProjectText } from "../hooks/queries";
import { useUiStore } from "../stores/ui";
import { SvgViewer } from "./SvgViewer";
import { useRunTool } from "./tools";

type CircuitToSvg = typeof import("circuit-to-svg");
type CircuitJson = Parameters<CircuitToSvg["convertCircuitJsonToSchematicSvg"]>[0];

/** Schematic / PCB tab: prefers the daemon's rendered SVG, else converts circuit.json client-side. */
export function SvgTab({ kind }: { kind: "schematic" | "pcb" }) {
  const projectId = useUiStore((s) => s.activeProjectId);
  const rendered = useProjectText(projectId, `renders/${kind}.svg`);
  const needsCircuit = rendered.data === null;
  // The PCB view prefers the routed copy so traces show up; the schematic only needs the build output.
  const routed = useProjectJson<unknown[]>(projectId, needsCircuit && kind === "pcb" ? "circuit.routed.json" : null);
  const useRouted = kind === "pcb" && Array.isArray(routed.data);
  const circuit = useProjectJson<unknown[]>(projectId, needsCircuit && !useRouted ? "circuit.json" : null);
  const circuitSource = useRouted ? "circuit.routed.json" : "circuit.json";
  const [generated, setGenerated] = useState<{ key: string; svg: string } | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const build = useRunTool();

  const circuitData = useRouted ? routed.data : circuit.data;
  useEffect(() => {
    if (!needsCircuit || !circuitData || !Array.isArray(circuitData)) return;
    let alive = true;
    setGenError(null);
    import("circuit-to-svg")
      .then((m) => {
        const fn = kind === "schematic" ? m.convertCircuitJsonToSchematicSvg : m.convertCircuitJsonToPcbSvg;
        const svg = fn(circuitData as CircuitJson);
        if (alive) setGenerated({ key: `${projectId}:${kind}:${circuitSource}`, svg });
      })
      .catch((e: unknown) => {
        if (alive) setGenError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [needsCircuit, circuitData, kind, projectId, circuitSource]);

  if (!projectId) return <EmptyState title="No project selected">Pick a project in the sidebar to see its {kind}.</EmptyState>;
  if (rendered.isLoading || (needsCircuit && circuit.isLoading)) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  const svg = rendered.data ?? (generated?.key === `${projectId}:${kind}:${circuitSource}` ? generated.svg : null);
  if (svg) {
    return (
      <div className="h-full" data-testid={`board-${kind}-svg`}>
        <SvgViewer
          svg={svg}
          toolbar={
            <span className="text-[11px] text-muted">{rendered.data ? `renders/${kind}.svg` : `generated from ${circuitSource}`}</span>
          }
        />
      </div>
    );
  }
  if (genError || circuit.parseError) {
    return <EmptyState title="Could not render">{genError ?? circuit.parseError}</EmptyState>;
  }
  return (
    <div className="h-full" data-testid={`board-${kind}-empty`}>
    <EmptyState
      title={`No ${kind} yet`}
      action={
        <Button
          variant="primary"
          size="sm"
          disabled={build.state.status === "running"}
          onClick={() => void build.run("build", { projectId })}
        >
          {build.state.status === "running" ? "Building..." : "Build circuit"}
        </Button>
      }
    >
      Ask the agent to write the circuit, or build the existing source to produce circuit.json.
      {build.state.error && <div className="mt-2 text-danger">{build.state.error}</div>}
    </EmptyState>
    </div>
  );
}
