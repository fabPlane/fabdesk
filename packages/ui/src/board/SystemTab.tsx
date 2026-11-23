import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CoreHttpError,
  partScopeKey,
  restoreAssemblySelection,
  useBoardSources,
  useCoreClient,
  usePartSelection,
  useProject,
} from "@fabdesk/client-core";
import {
  NetlistFile,
  buildSystemDiagramFromSources,
  formatSystemSummary,
  type DesignSources,
  type LaidOutBlock,
  type SystemDiagram,
} from "@fabdesk/protocol";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { useUiStore } from "../stores/ui";
import "./system-tab.css";

function isDesignPath(path: string): boolean {
  if (path.includes(".unrouted.") || /(^|\/)(renders|exports|\.fabdesk)\//.test(path)) return false;
  return path.endsWith(".kicad_pcb") || path.endsWith(".kicad_sch") || path.endsWith("circuit.netlist.json");
}

function preferPcb(paths: string[], prefix: string): string | undefined {
  const pcbs = paths.filter((path) => path.endsWith(".kicad_pcb"));
  return pcbs.find((path) => path === `${prefix}board.kicad_pcb`) ?? pcbs[0];
}

async function readOptional(client: { readFile: (projectId: string, path: string) => Promise<string> }, projectId: string, path: string): Promise<string | null> {
  try {
    return await client.readFile(projectId, path);
  } catch (error) {
    if (error instanceof CoreHttpError && error.status === 404) return null;
    throw error;
  }
}

export function SystemTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
  if (!projectId) return <EmptyState title="Choose a project" />;
  return <ProjectSystem key={projectId} projectId={projectId} />;
}

function ProjectSystem({ projectId }: { projectId: string }) {
  const client = useCoreClient();
  const project = useProject(projectId);
  const sources = useBoardSources(projectId);
  const saved = useUiStore((s) => s.assemblyBoardByProject[projectId]);
  const selection = sources.data?.mode === "assembly" ? restoreAssemblySelection(sources.data, saved) : null;
  const row = selection ? sources.data?.sources.find((item) => item.source.id === selection.sourceId) : undefined;
  const prefix = row?.source.location === "project" && row.source.directory !== "." ? `${row.source.directory}/` : "";
  const board = selection ?? undefined;
  const files = (project.data?.files ?? []).map((file) => file.path).filter((path) => path.startsWith(prefix) && isDesignPath(path)).sort();
  const diagramQuery = useQuery({
    queryKey: ["system-diagram", client.baseUrl, projectId, prefix, files],
    enabled: !!project.data && !project.isError,
    staleTime: 15_000,
    queryFn: async (): Promise<SystemDiagram> => {
      const pcbPath = preferPcb(files, prefix);
      const netlistPath = files.find((path) => path === `${prefix}circuit.netlist.json`);
      const schematics = files.filter((path) => path.endsWith(".kicad_sch"));
      const [pcbText, netlistText, schTexts] = await Promise.all([
        pcbPath ? readOptional(client, projectId, pcbPath) : Promise.resolve(null),
        netlistPath ? readOptional(client, projectId, netlistPath) : Promise.resolve(null),
        Promise.all(schematics.map(async (path) => ({ name: path.slice(prefix.length).replace(/\.kicad_sch$/i, ""), text: await readOptional(client, projectId, path) }))),
      ]);
      let parsed: ReturnType<typeof NetlistFile.safeParse> | null = null;
      if (netlistText) {
        try { parsed = NetlistFile.safeParse(JSON.parse(netlistText)); } catch { parsed = null; }
      }
      const design: DesignSources = {
        ...(parsed?.success ? { netlist: parsed.data } : {}),
        ...(pcbText ? { pcbText } : {}),
        ...(schTexts.some((item) => item.text) ? { schematics: schTexts.filter((item): item is { name: string; text: string } => !!item.text) } : {}),
      };
      return buildSystemDiagramFromSources(design);
    },
  });
  const diagram = diagramQuery.data;
  const summary = diagram ? formatSystemSummary(diagram) : "";
  const scope = partScopeKey({ endpoint: client.baseUrl, projectId, ...(board ? { sourceId: board.sourceId, manifestSha256: board.manifestSha256 } : {}) });
  const selected = usePartSelection((s) => s.selection?.scope === scope ? s.selection : null);
  const selectedRefs = selected?.refs ?? (selected?.ref ? [selected.ref] : []);
  const selectedBlock = diagram?.blocks.find((block) => selectedRefs.length && selectedRefs.every((ref) => block.parts.some((part) => part.ref === ref)) && block.parts.some((part) => selectedRefs.includes(part.ref)));

  useAssistantSurface(projectId ? {
    projectId,
    label: "Board / System",
    priority: 12,
    details: JSON.stringify({
      board: board ?? null,
      sourceDirectory: prefix || ".",
      selectedBlock: selectedBlock ? { id: selectedBlock.id, name: selectedBlock.name, kind: selectedBlock.kind, parts: selectedBlock.parts.map((part) => part.ref) } : null,
      summary: summary.slice(0, 5000),
      instruction: "This is an automatically grouped block diagram of the saved design. Inspect native sources before editing or making electrical claims.",
    }),
  } : null);

  const selectBlock = (block: LaidOutBlock) => {
    if (useUiStore.getState().activeProjectId !== projectId) return;
    const refs = block.parts.map((part) => part.ref);
    const first = refs[0];
    if (!first) return;
    usePartSelection.getState().select(scope, first, refs);
  };

  if (project.isError || sources.isError) return <LoadError title="Could not load the system diagram" onRetry={() => { void project.refetch(); void sources.refetch(); void diagramQuery.refetch(); }} />;
  if (!project.data || sources.isPending || diagramQuery.isPending) return <div className="fd-system-tab flex h-full items-center justify-center"><Spinner /></div>;
  if (diagramQuery.isError) return <LoadError title="Could not build the system diagram" onRetry={() => void diagramQuery.refetch()} />;
  if (!diagram || diagram.blocks.length === 0) return <EmptyState title="No system blocks yet"><p>Add a saved schematic or PCB so fabPlane can group the design into functional blocks.</p></EmptyState>;

  return <div className="fd-system-tab" data-testid="board-system">
    <SystemDiagramView
      diagram={diagram}
      selectedId={selectedBlock?.id ?? null}
      onSelect={selectBlock}
      onClear={() => usePartSelection.getState().clear(scope)}
    />
  </div>;
}

function SystemDiagramView({ diagram, selectedId, onSelect, onClear }: {
  diagram: SystemDiagram;
  selectedId: string | null;
  onSelect: (block: LaidOutBlock) => void;
  onClear: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [camera, setCamera] = useState({ x: 0, y: 0, scale: 1 });
  const cameraRef = useRef(camera);
  cameraRef.current = camera;
  const fittedKey = useRef("");
  const drag = useRef<{ id: number; x: number; y: number; camX: number; camY: number; moved: boolean } | null>(null);

  const fit = (frameW = size.width, frameH = size.height) => {
    const pad = 48;
    const scale = Math.max(0.25, Math.min(2.4, Math.min((frameW - pad) / Math.max(diagram.width, 1), (frameH - pad) / Math.max(diagram.height, 1))));
    setCamera({
      x: (diagram.width - frameW / scale) / 2,
      y: (diagram.height - frameH / scale) / 2,
      scale,
    });
  };

  useLayoutEffect(() => {
    const frame = viewport.current;
    if (!frame) return;
    const measure = () => setSize({ width: Math.max(1, frame.clientWidth), height: Math.max(1, frame.clientHeight) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (size.width < 32 || size.height < 32) return;
    const key = `${diagram.width}:${diagram.height}`;
    if (fittedKey.current === key) return;
    fittedKey.current = key;
    fit(size.width, size.height);
  }, [diagram.width, diagram.height, size.width, size.height]);

  useEffect(() => {
    const frame = viewport.current;
    if (!frame) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const rect = frame.getBoundingClientRect();
      const current = cameraRef.current;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.clientHeight : 1;
      const delta = Math.max(-240, Math.min(240, event.deltaY * unit));
      const next = Math.max(0.25, Math.min(4, current.scale * Math.exp(-delta * 0.002)));
      if (next === current.scale) return;
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const worldX = current.x + mx / current.scale;
      const worldY = current.y + my / current.scale;
      setCamera({ x: worldX - mx / next, y: worldY - my / next, scale: next });
    };
    frame.addEventListener("wheel", wheel, { passive: false });
    return () => frame.removeEventListener("wheel", wheel);
  }, []);

  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);

  return <div className="fd-system-stage">
    <div
      ref={viewport}
      className="fd-system-viewport"
      tabIndex={0}
      data-testid="system-diagram"
      aria-label="System block diagram. Drag to pan, scroll to zoom. Click a block to highlight its parts in schematic and PCB views."
      onPointerDown={(event) => {
        if (event.button !== 0 && event.button !== 1) return;
        if (event.target instanceof Element && event.target.closest("button")) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, camX: camera.x, camY: camera.y, moved: false };
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state || state.id !== event.pointerId) return;
        const dx = event.clientX - state.x;
        const dy = event.clientY - state.y;
        if (!state.moved && Math.hypot(dx, dy) < 4) return;
        state.moved = true;
        setCamera((current) => ({ ...current, x: state.camX - dx / current.scale, y: state.camY - dy / current.scale }));
      }}
      onPointerUp={(event) => {
        const state = drag.current;
        drag.current = null;
        if (state?.moved) return;
        const id = event.target instanceof Element ? event.target.closest("[data-block-id]")?.getAttribute("data-block-id") : null;
        const block = id ? diagram.blocks.find((item) => item.id === id) : undefined;
        if (block) onSelect(block);
        else onClear();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && selectedId) { onClear(); event.preventDefault(); }
        if (event.key === "+" || event.key === "=") setCamera((current) => ({ ...current, scale: Math.min(4, current.scale * 1.2) }));
        if (event.key === "-" || event.key === "_") setCamera((current) => ({ ...current, scale: Math.max(0.25, current.scale / 1.2) }));
      }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`${camera.x} ${camera.y} ${width / camera.scale} ${height / camera.scale}`}
        role="img"
        aria-label="Automatically grouped system blocks"
      >
        {diagram.edges.map((edge, index) => (
          <g key={`${edge.from}-${edge.to}-${edge.kind}-${index}`} className="fd-system-edge" data-kind={edge.kind}>
            <path d={edge.path} fill="none" />
            <text x={edge.labelX} y={edge.labelY} textAnchor="middle">{edge.labels.join(" · ")}</text>
          </g>
        ))}
        {diagram.blocks.map((block) => {
          const selected = block.id === selectedId;
          return <g
            key={block.id}
            className="fd-system-block"
            data-kind={block.kind}
            data-selected={selected || undefined}
            data-block-id={block.id}
            transform={`translate(${block.x} ${block.y})`}
          >
            <rect width={block.w} height={block.h} rx="10" />
            <text className="fd-system-block-title" x="14" y="22">{block.name}</text>
            <text className="fd-system-block-kind" x="14" y="38">{block.source === "sheet" ? `${kindCaption(block.kind)} · sheet` : kindCaption(block.kind)}</text>
            {block.keyParts.map((part, line) => (
              <text key={part.ref} className="fd-system-block-part" x="14" y={58 + line * 16}>
                {part.ref}{part.value ? `  ${part.value}` : ""}
              </text>
            ))}
            {block.passiveSummary ? <text className="fd-system-block-passives" x="14" y={58 + Math.max(1, block.keyParts.length) * 16}>{block.passiveSummary}</text> : null}
          </g>;
        })}
      </svg>
    </div>
    <div className="fd-system-tools" data-canvas-tools>
      <Button size="sm" title="Zoom out" aria-label="Zoom out" onClick={() => setCamera((current) => ({ ...current, scale: Math.max(0.25, current.scale / 1.2) }))}>−</Button>
      <span>{Math.round(camera.scale * 100)}%</span>
      <Button size="sm" title="Zoom in" aria-label="Zoom in" onClick={() => setCamera((current) => ({ ...current, scale: Math.min(4, current.scale * 1.2) }))}>+</Button>
      <Button size="sm" onClick={() => fit()}>Fit</Button>
      <span>Click a block to highlight its parts · Drag to pan</span>
    </div>
  </div>;
}

function kindCaption(kind: LaidOutBlock["kind"]): string {
  return {
    power: "Power",
    mcu: "MCU / processor",
    io: "Connectors / IO",
    sensors: "Sensors",
    motor: "Motor drivers",
    rf: "RF",
    other: "Logic",
    passives: "Passives",
  }[kind];
}
