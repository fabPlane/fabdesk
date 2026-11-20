import { lazy, Suspense, useMemo, useRef, useState } from "react";
import type { BoardSourceSelection, BoardLayers } from "@fabdesk/protocol";
import { useAutomaticBoardViews, useBoardSources, useProject } from "@fabdesk/client-core";
import { Button, EmptyState, LoadError, Spinner } from "../components/ui";
import { SvgViewer } from "./SvgViewer";
import "./board-preview.css";

const ModelCanvas = lazy(() => import("./ModelCanvas"));
const names: Record<string, string> = { "F.Cu": "Top copper", "B.Cu": "Bottom copper", "F.SilkS": "Top silkscreen", "B.SilkS": "Bottom silkscreen", "F.Mask": "Top solder mask", "B.Mask": "Bottom solder mask", "F.Paste": "Top solder paste", "B.Paste": "Bottom solder paste", "Edge.Cuts": "Board outline" };
export function boardLayerColor(svg: string) {
  const counts = new Map<string, number>();
  for (const match of svg.matchAll(/(?:stroke|fill):\s*(#[a-fA-F0-9]{6})/g)) {
    const color = match[1]!.toLowerCase();
    if (color !== "#000000" && color !== "#ffffff") counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "#9baea5";
}

/** Exported layers share native page coordinates. Display SVGs as images, never active markup. */
export function combineBoardLayers(layers: BoardLayers["layers"], hidden: ReadonlySet<string>): string {
  const first = layers[0]?.svg.match(/<svg\b[^>]*>/)?.[0];
  if (!first) return "";
  return first + layers.filter(layer => !hidden.has(layer.name)).map(layer => {
    const start = layer.svg.indexOf(">", layer.svg.indexOf("<svg")) + 1;
    return `<g>${layer.svg.slice(start, layer.svg.lastIndexOf("</svg>"))}</g>`;
  }).join("") + "</svg>";
}

export function BoardPreview({ projectId, mode, directory = ".", board, sourceStamp, enabled = true }: {
  projectId: string; mode: "pcb" | "3d" | "layers"; directory?: string;
  board?: BoardSourceSelection; sourceStamp: string; enabled?: boolean;
}) {
  const previews = useAutomaticBoardViews({ projectId, directory, sourceStamp, enabled, ...(board ? { board } : {}) });
  const [side, setSide] = useState<"top" | "bottom">("top");
  const [showComponents, setShowComponents] = useState(true);
  const [viewRevision, setViewRevision] = useState(0);
  const [selectionToolbar, setSelectionToolbar] = useState<HTMLDivElement | null>(null);
  const modelView = useRef<"2d" | "3d">("2d");
  if (mode !== "layers") modelView.current = mode === "pcb" ? "2d" : "3d";
  const [hidden, setHidden] = useState<Set<string>>(() => new Set());
  const drawing = useMemo(() => combineBoardLayers(previews.layers.data?.layers ?? [], hidden), [previews.layers.data, hidden]);
  const layerColors = useMemo(() => new Map(previews.layers.data?.layers.map(layer => [layer.name, boardLayerColor(layer.svg)]) ?? []), [previews.layers.data]);
  const layerView = mode === "layers", current = layerView ? previews.layers : previews.model;
  const error = previews.source.error ?? (!layerView ? previews.refreshModel.error : null) ?? current.error;
  const loadingModels = !layerView && !!previews.model.data?.pendingModels && previews.model.isFetching;
  let status = "Saved board · previews ready";
  if (error) status = "Preview needs attention";
  else if (loadingModels) status = "Loading component models…";
  else if (!layerView && previews.model.data?.pendingModels) status = "Showing available components";
  else if (!enabled) status = "Checking board source…";
  else if (previews.refreshModel.isPending || previews.model.isFetching || previews.layers.isFetching || previews.source.isFetching) status = "Preparing board views…";
  return <div className="fd-board-preview" data-testid="automatic-board-preview" data-mode={mode}>
    <div className="fd-preview-topbar">
      <div className="fd-preview-side" aria-label="Board side" hidden={layerView}>
        {(["top", "bottom"] as const).map(value => <Button key={value} size="sm" variant={side === value ? "primary" : "ghost"} aria-pressed={side === value} onClick={() => { setSide(value); setViewRevision(revision => revision + 1); }}>{value === "top" ? "Top" : "Bottom"}</Button>)}
      </div>
      <div className="fd-preview-side" role="group" aria-label="Board assembly" hidden={layerView}>
        <Button size="sm" variant={showComponents ? "primary" : "ghost"} aria-pressed={showComponents} onClick={() => setShowComponents(true)}>Assembled</Button>
        <Button size="sm" variant={!showComponents ? "primary" : "ghost"} aria-pressed={!showComponents} onClick={() => setShowComponents(false)}>Bare board</Button>
      </div>
      <div className="fd-preview-selection" ref={setSelectionToolbar} hidden={layerView || !showComponents} />
      {!layerView && <Button size="sm" variant="ghost" disabled={!enabled || !previews.source.data || previews.source.isFetching || previews.model.isFetching || previews.refreshModel.isPending} onClick={() => previews.refreshModel.mutate()}>{previews.refreshModel.isPending ? "Refreshing preview…" : "Refresh preview"}</Button>}
      <span className="fd-board-preview-status" role="status">{status}</span>
    </div>
    <div className="fd-preview-stage">
      <div className="fd-preview-surface" style={{ visibility: layerView ? "hidden" : "visible" }} inert={layerView || undefined} aria-hidden={layerView}>
        {previews.model.data && <Suspense fallback={<Spinner />}><ModelCanvas projectId={projectId} path={previews.path} blob={previews.model.data.blob} viewMode={modelView.current} side={side} viewRevision={viewRevision} showComponents={showComponents} selectionToolbar={selectionToolbar} selectionSource={{ projectId, ...(board ? { board } : {}), enabled }} /></Suspense>}
      </div>
      <div className="fd-preview-surface fd-preview-layers" style={{ visibility: layerView ? "visible" : "hidden" }} inert={!layerView || undefined} aria-hidden={!layerView}>
        {previews.layers.data && <><aside aria-label="PCB layers"><header><strong>Layers</strong><Button size="sm" variant="ghost" onClick={() => setHidden(new Set())}>Show all</Button></header>{previews.layers.data.layers.map(layer => <label key={layer.name}><input type="checkbox" checked={!hidden.has(layer.name)} onChange={event => setHidden(previous => { const next = new Set(previous); if (event.target.checked) next.delete(layer.name); else next.add(layer.name); return next; })} /><span className="fd-layer-swatch" style={{ background: layerColors.get(layer.name) }} /><span>{names[layer.name] ?? layer.name.replace(/^In(\d+)\.Cu$/, "Inner $1 copper")}<small>{layer.name}</small></span></label>)}</aside><div className="fd-layer-drawing"><SvgViewer svg={drawing} viewKey={`${projectId}:${directory}:layers`} fitLabel="Fit board" />{hidden.size >= previews.layers.data.layers.length && <div className="fd-preview-notice">All layers hidden. Select a layer to show it.</div>}</div></>}
      </div>
      {!layerView && showComponents && !!previews.model.data?.warnings.length && <details className="fd-preview-model-notes"><summary>Model export notes</summary><p>KiCad reported the following while preparing this preview.</p><ul>{previews.model.data.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details>}
      {!current.data && !error && <div className="fd-preview-loading" role="status"><Spinner /><strong>Preparing your board</strong><span>You can switch views while previews load.</span></div>}
      {error && !current.data && <div className="fd-preview-loading"><LoadError title="Could not prepare this view" onRetry={() => { if (previews.source.isError) void previews.source.refetch(); else if (!layerView && previews.refreshModel.isError) previews.refreshModel.mutate(); else void current.refetch(); }} /><p>{error instanceof Error ? error.message : "Try again."}</p></div>}
    </div>
  </div>;
}

export function RootBoardPreview({ projectId, mode }: { projectId: string; mode: "pcb" | "3d" | "layers" }) {
  const project = useProject(projectId), sources = useBoardSources(projectId);
  const file = project.data?.files.find(file => file.path === "board.kicad_pcb");
  if (project.isError || sources.isError) return <LoadError title="Could not inspect board source" onRetry={() => { void project.refetch(); void sources.refetch(); }} />;
  if (project.isPending || sources.isPending) return <div className="fd-preview-loading"><Spinner /></div>;
  if (!file || sources.data?.mode !== "single") return <EmptyState title="Your board preview will appear here">Save a PCB to see its 2D, 3D and layer views automatically.</EmptyState>;
  return <BoardPreview projectId={projectId} mode={mode} sourceStamp={`${file.mtime}:${file.size}`} enabled={!sources.isFetching} />;
}
