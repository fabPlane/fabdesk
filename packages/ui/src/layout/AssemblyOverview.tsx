import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { overviewBoardImages, useProject, type OverviewImage } from "@fabdesk/client-core";
import { useOverviewImage } from "./useOverviewImage";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { BoardViewTabs } from "../board/BoardViewTabs";
import { WorkspaceMenu } from "./WorkspaceMenu";
import { AssemblySchematicPreview } from "../board/AssemblySchematicPreview";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { ASSEMBLY_MANIFEST_PATH, PCB_PREVIEW_REVISION_PATH, type BoardSourceSelection, type ProjectBoardSources } from "@fabdesk/protocol";
import { assemblyMapLayoutKey, restoreAssemblyMapLayout, useCoreClient, type AssemblyMapLayout, nextAssemblyReviewSelection, assemblyModelNeedsReview, assemblyModelSummaryLabel, useAssemblyModelSummaries, assemblyCheckFindingOwned, assemblyFindingPreviewMatches, assemblyCheckNeedsReview, assemblyCheckSummaryLabel, useAssemblyCheckSummaries, pcbSvgHasNativeCoordinates, restoreAssemblySelection, assemblyLinkShape, assemblyScene, assemblySourcesToReview, assemblySelectionState, captureAssemblySelection, useAssemblyBoardInspection, useAssemblyPreviewRevisions, usePcbPreviewRevision, useProjectText, useRunTool, type AssemblySceneNode, type AssemblySceneSelection } from "@fabdesk/client-core";
import { Button, Dialog, EmptyState, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { SvgViewer } from "../board/SvgViewer";
import { useSourceCommentTools } from "../board/SourceCommentTools";
import { AssemblyBoardModel } from "../board/AssemblyBoardModel";
import { NativePartTools } from "../board/NativePartTools";
import { parseSvgViewBox } from "../board/svg-coords";
import { ProjectImage } from "../chat/ProjectImage";
import { useUiStore } from "../stores/ui";

type Box = { x: number; y: number; width: number; height: number };
type MapDrag = { selection: AssemblySceneSelection; scopeKey: string; pointerId: number; clientX: number; clientY: number; x: number; y: number; scaleX: number; scaleY: number; nextX: number; nextY: number; moved: boolean; layout: AssemblyMapLayout };
type Detail = { selection: AssemblySceneSelection; directory: string; previewPath: string | null; instanceName: string; sourceName: string };
const shortened = (value: string, length = 25) => value.length > length ? `${value.slice(0, length - 1)}…` : value;
function fitBox(bounds: Box, aspect: number): Box {
  const width = Math.max(bounds.width, bounds.height * aspect), height = width / aspect;
  return { x: bounds.x + (bounds.width - width) / 2, y: bounds.y + (bounds.height - height) / 2, width, height };
}
function previewCopy(state: string | undefined, checking: boolean, failed: boolean, exists: boolean) {
  return checking ? "Checking preview…" : failed ? "Preview check unavailable" : !exists ? "No saved preview" : state === "matches-source" ? "Preview matches saved PCB" : state === "source-changed" ? "PCB changed since preview" : state === "artifact-changed" ? "Preview changed · unverified" : "Saved preview · unverified";
}
function BoardImage({ projectId, node, candidates }: { projectId: string; node: AssemblySceneNode; candidates: OverviewImage[] }) {
  const image = useOverviewImage(projectId, candidates);
  return image.url ? <image href={image.url} x={12} y={12} width={node.width - 24} height={node.height - 68} preserveAspectRatio="xMidYMid meet" pointerEvents="none" onError={image.onError}><title>{image.candidate?.kind === "top" ? "Saved top render" : "Saved board image"} · freshness unverified</title></image>
    : <g className="fd-assembly-placeholder" transform={`translate(${node.width / 2 - 105},16)`} pointerEvents="none"><rect x={70} y={26} width={70} height={52} rx={6} /><path d="M88 18v8m16-8v8m16-8v8M88 78v8m16-8v8m16-8v8M62 39h8m-8 15h8m70-15h8m-8 15h8" /><text x={105} y={102} textAnchor="middle">{image.loading ? "Loading preview…" : node.source?.status === "available" ? "No board image" : "Source unavailable"}</text></g>;
}
function askAbout(selection: AssemblySceneSelection | null, name: string, available: boolean) {
  if (!selection) return;
  const projectId = selection.projectId;
  const ui = useUiStore.getState(); if (ui.activeProjectId !== projectId) return;
  askAboutSurface({ projectId, label: `Board / ${name}`, priority: 20, details: JSON.stringify({ selection, available, instruction: "Verify the current project declaration and whether this source is shared. Inspect saved source and declared connections before proposing changes; connection compatibility is unverified." }) }, available ? `Review ${name} and its board connections. Explain what needs attention before changing the design.` : `Help resolve the missing source for ${name}. Check project files and the declared origin first.`);
}

/** Logical project topology. Canvas positions and declared links never imply chassis fit or electrical validation. */
export function AssemblyOverview({ projectId, name, data, checking, failed, onRetry, boardPicker = false }: { boardPicker?: boolean; projectId: string; name: string; data: ProjectBoardSources; checking: boolean; failed: boolean; onRetry: () => void }) {
  const projectFiles = useProject(projectId);
  const client = useCoreClient(), layoutKey = assemblyMapLayoutKey(client.baseUrl, projectId);
  const savedLayout = useUiStore(state => state.assemblyMapLayouts?.[layoutKey]);
  const [assemblyViewOpen, setAssemblyViewOpen] = useState(false);
  const [transientLayout, setTransientLayout] = useState<AssemblyMapLayout | null>(null);
  const savedPositions = useMemo(() => restoreAssemblyMapLayout(data, savedLayout), [data, savedLayout]);
  const scene = useMemo(() => assemblyScene(data, transientLayout ?? savedLayout), [data, transientLayout, savedLayout]);
  const mapDrag = useRef<MapDrag | null>(null);
  const savedBoard = useUiStore(state => state.assemblyBoardByProject[projectId]);
  const restored = restoreAssemblySelection(data, savedBoard);
  const detailFor = (selection: AssemblySceneSelection | null): Detail | null => {
    if (!selection) return null;
    const node = scene.nodes.find(row => row.instance.id === selection.instanceId), source = node?.source;
    return node && source?.source.location === "project" ? { selection, directory: source.source.directory, previewPath: source.previewPath ?? null, instanceName: node.instance.name, sourceName: source.source.name } : null;
  };
  const update = useRunTool(), [updateSourceId, setUpdateSourceId] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null), viewport = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), tools = useRef<HTMLDivElement>(null);
  const fitButton = useRef<HTMLButtonElement>(null);
  const nodeElements = useRef(new Map<string, SVGGElement>()), linkElements = useRef(new Map<string, SVGGElement>());
  const measured = useRef(false);
  const dimensions = useRef({ width: 1000, height: 600 });
  const [camera, setCamera] = useState<Box>(() => fitBox(scene.bounds, 1.7));
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const boundsRef = useRef(scene.bounds); boundsRef.current = scene.bounds;
  const [selected, setSelected] = useState<AssemblySceneSelection | null>(null), [linkId, setLinkId] = useState<string | null>(null), [linkHash, setLinkHash] = useState<string | null>(null), [detail, setDetail] = useState<Detail | null>(() => boardPicker ? detailFor(restored) : null);
  // Only navigation restores a captured selection; live declaration changes keep the active editor stale.
  useEffect(() => { setDetail(boardPicker ? detailFor(restoreAssemblySelection(data, useUiStore.getState().assemblyBoardByProject[projectId])) : null); }, [boardPicker, projectId, savedBoard]);
  const [toolStyle, setToolStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const previews = useAssemblyPreviewRevisions(projectId, data.sources);
  const previewById = new Map(previews.map(state => [state.sourceId, state]));
  const models = useAssemblyModelSummaries(projectId, data);
  const modelById = new Map((models.data ?? []).map(row => [row.sourceId, row]));
  const checks = useAssemblyCheckSummaries(projectId, data);
  const checkById = new Map((checks.data ?? []).map(row => [row.sourceId, row]));
  const sourcesToReview = [...new Set([...assemblySourcesToReview(data, new Map(previews.filter(state => state.trackable).map(state => [state.sourceId, state.data]))), ...(!models.isFetching && !models.isError ? (models.data ?? []).filter(assemblyModelNeedsReview).map(row => row.sourceId) : []), ...(!checks.isFetching && !checks.isError ? (checks.data ?? []).filter(assemblyCheckNeedsReview).map(row => row.sourceId) : [])])];
  const selectedNode = selected ? scene.nodes.find(node => node.instance.id === selected.instanceId) : undefined;
  const selectedLink = scene.links.find(link => link.connection.id === linkId);
  useAssistantSurface({ projectId, label: detail ? `Board · ${detail.instanceName}` : selectedLink ? "Overview · Connection" : selectedNode ? `Overview · ${selectedNode.instance.name}` : "Project overview", priority: 10, details: JSON.stringify({ board: detail?.selection ?? selected, source: detail?.directory, selectedConnection: selectedLink?.connection, ownershipCheckPending: checking || failed, declaredConnectionsOnly: true }) });
  const linkStale = !!linkId && linkHash !== data.manifestSha256;
  const ownership = selected ? assemblySelectionState(data, selected) : null;
  const unavailable = checking || failed;
  const fit = () => setCamera(fitBox(boundsRef.current, dimensions.current.width / dimensions.current.height));
  const zoom = (factor: number, point?: { x: number; y: number }) => setCamera(previous => {
    const nextWidth = previous.width / factor;
    if (nextWidth < 120 || nextWidth > 10_000_000) return previous;
    const anchor = point ?? { x: previous.x + previous.width / 2, y: previous.y + previous.height / 2 };
    return { x: anchor.x - (anchor.x - previous.x) / factor, y: anchor.y - (anchor.y - previous.y) / factor, width: nextWidth, height: previous.height / factor };
  });
  useEffect(() => {
    const element = viewport.current; if (!element || detail) return;
    const measure = () => {
      const width = element.clientWidth, height = element.clientHeight; if (!width || !height) return;
      dimensions.current = { width, height };
      const first = !measured.current; measured.current = true;
      setCamera(previous => first ? fitBox(boundsRef.current, width / height) : { ...previous, x: previous.x + (previous.width - previous.height * width / height) / 2, width: previous.height * width / height });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect();
  }, [!!detail]);
  useEffect(() => {
    const element = viewport.current; if (!element || detail) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); if (mapDrag.current) return; const rect = element.getBoundingClientRect(), current = cameraRef.current;
      zoom(Math.exp(-Math.max(-120, Math.min(120, event.deltaY)) * .0025), { x: current.x + (event.clientX - rect.left) / rect.width * current.width, y: current.y + (event.clientY - rect.top) / rect.height * current.height });
    };
    element.addEventListener("wheel", wheel, { passive: false }); return () => element.removeEventListener("wheel", wheel);
  }, [!!detail]);
  useLayoutEffect(() => {
    if ((!selectedNode && !selectedLink) || detail) return;
    const place = () => {
      const host = root.current?.getBoundingClientRect(), bar = tools.current?.getBoundingClientRect();
      const target = selectedNode ? nodeElements.current.get(selectedNode.instance.id)?.getBoundingClientRect() : selectedLink ? linkElements.current.get(selectedLink.connection.id)?.getBoundingClientRect() : null;
      if (!host || !bar) return;
      const width = Math.min(bar.width, host.width - 32), center = target ? target.left + target.width / 2 - host.left : host.width / 2;
      const top = target && target.top - host.top > 170 ? target.top - host.top - bar.height - 12 : target ? target.bottom - host.top + 12 : 184;
      const headingBottom = root.current?.querySelector(".fd-assembly-heading")?.getBoundingClientRect().bottom ?? host.top + 158;
      setToolStyle({ maxWidth: host.width - 32, left: Math.max(16, Math.min(center - width / 2, host.width - width - 16)), top: Math.max(headingBottom - host.top + 12, Math.min(top, host.height - bar.height - 90)) });
    };
    place(); const observer = new ResizeObserver(place); if (tools.current) observer.observe(tools.current);
    window.addEventListener("resize", place); return () => { observer.disconnect(); window.removeEventListener("resize", place); };
  }, [selectedNode, selectedLink, camera, detail, ownership, checking]);
  const dismissSelection = () => {
    const target = selectedNode ? nodeElements.current.get(selectedNode.instance.id) : selectedLink ? linkElements.current.get(selectedLink.connection.id) : viewport.current;
    setSelected(null); setLinkId(null);
    requestAnimationFrame(() => target?.focus());
  };
  const focusToolsFrom = (origin: Element, selectionKey: string, allowRemovedOrigin = false) => {
    requestAnimationFrame(() => {
      const removedTrigger = allowRemovedOrigin && !origin.isConnected && document.activeElement === document.body;
      if (useUiStore.getState().activeProjectId !== projectId || document.activeElement !== origin && !removedTrigger || tools.current?.dataset.contextSelection !== selectionKey) return;
      tools.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    });
  };
  const choose = (node: AssemblySceneNode) => { if (unavailable) return; setSelected(captureAssemblySelection(data, node.instance.id)); setLinkId(null); };
  const inspect = (node: AssemblySceneNode) => {
    if (unavailable) return;
    const selection = captureAssemblySelection(data, node.instance.id), source = node.source;
    if (!selection || !source || source.status !== "available" || source.source.location !== "project") return;
    useUiStore.getState().setAssemblyBoard(selection);
    useUiStore.getState().setBoardTab("pcb");
    setDetail({ selection, directory: source.source.directory, previewPath: source.previewPath ?? null, instanceName: node.instance.name, sourceName: source.source.name });
  };
  const followEndpoint = (node: AssemblySceneNode, origin: Element) => {
    if (unavailable || linkStale) return;
    if (node.source?.status === "available") inspect(node);
    else { choose(node); focusToolsFrom(origin, `board:${node.instance.id}`, true); }
  };
  const cancelMapDrag = () => {
    const start = mapDrag.current; if (!start) return;
    mapDrag.current = null; setTransientLayout(null);
    const element = nodeElements.current.get(start.selection.instanceId);
    if (element?.hasPointerCapture(start.pointerId)) element.releasePointerCapture(start.pointerId);
  };
  const beginMapDrag = (event: ReactPointerEvent<SVGGElement>, node: AssemblySceneNode) => {
    if (event.button !== 0 || unavailable || mapDrag.current) return;
    const selection = captureAssemblySelection(data, node.instance.id), box = viewport.current?.getBoundingClientRect();
    if (!selection || !box?.width || !box.height) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId); choose(node);
    mapDrag.current = { selection, scopeKey: layoutKey, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: node.x, y: node.y, scaleX: cameraRef.current.width / box.width, scaleY: cameraRef.current.height / box.height, nextX: node.x, nextY: node.y, moved: false, layout: Object.fromEntries(savedPositions) };
  };
  const mapCoordinate = (value: number) => Math.max(-1e6, Math.min(1e6, Math.round(value * 10) / 10));
  const moveMapDrag = (event: ReactPointerEvent<SVGGElement>) => {
    const start = mapDrag.current; if (!start || start.pointerId !== event.pointerId) return;
    if (start.scopeKey !== layoutKey || assemblySelectionState(data, start.selection) === "stale" || failed) { cancelMapDrag(); return; }
    event.stopPropagation();
    const dx = event.clientX - start.clientX, dy = event.clientY - start.clientY;
    if (!start.moved && Math.hypot(dx, dy) < 4) return;
    start.moved = true; start.nextX = mapCoordinate(start.x + dx * start.scaleX); start.nextY = mapCoordinate(start.y + dy * start.scaleY);
    setTransientLayout({ ...start.layout, [start.selection.instanceId]: { units: "canvas-px", sourceId: start.selection.sourceId, x: start.nextX, y: start.nextY } });
  };
  const finishMapDrag = (event: ReactPointerEvent<SVGGElement>) => {
    const start = mapDrag.current; if (!start || start.pointerId !== event.pointerId) return;
    mapDrag.current = null;
    const dx = event.clientX - start.clientX, dy = event.clientY - start.clientY;
    if (start.moved || Math.hypot(dx, dy) >= 4) { start.moved = true; start.nextX = mapCoordinate(start.x + dx * start.scaleX); start.nextY = mapCoordinate(start.y + dy * start.scaleY); }
    if (start.moved && !failed && start.scopeKey === layoutKey && assemblySelectionState(data, start.selection) !== "stale") useUiStore.getState().setAssemblyMapPosition(start.scopeKey, projectId, start.selection.instanceId, { units: "canvas-px", sourceId: start.selection.sourceId, x: start.nextX, y: start.nextY });
    setTransientLayout(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  useEffect(() => {
    const start = mapDrag.current;
    if (start && (failed || start.scopeKey !== layoutKey || assemblySelectionState(data, start.selection) === "stale")) cancelMapDrag();
  }, [layoutKey, data, failed]);
  const resetMapLayout = () => {
    cancelMapDrag(); useUiStore.getState().resetAssemblyMapLayout(layoutKey, projectId);
    requestAnimationFrame(() => { fit(); if (useUiStore.getState().activeProjectId === projectId && document.activeElement === document.body) fitButton.current?.focus({ preventScroll: true }); });
  };
  const updatePreview = async (node: AssemblySceneNode) => {
    const selection = captureAssemblySelection(data, node.instance.id);
    if (unavailable || update.state.status === "running" || !selection || assemblySelectionState(data, selection) !== "owned") return;
    setUpdateSourceId(selection.sourceId);
    await update.run("render_pcb_svg", { projectId, board: { sourceId: selection.sourceId, manifestSha256: selection.manifestSha256 } });
  };
  const drag = useRef<{ pointerId: number; clientX: number; clientY: number; camera: Box } | null>(null);
  useEffect(() => { const cancel = () => { drag.current = null; cancelMapDrag(); }; window.addEventListener("blur", cancel); return () => { window.removeEventListener("blur", cancel); mapDrag.current = null; }; }, []);
  if (boardPicker && detail) return <AssemblyBoardDetail projectId={projectId} detail={detail} current={data} checking={checking} failed={failed} onBack={() => { useUiStore.getState().setAssemblyBoard(null); setDetail(null); requestAnimationFrame(() => nodeElements.current.get(detail.selection.instanceId)?.focus()); }} />;
  return <div ref={root} className="fd-assembly-overview" data-testid="assembly-overview" onKeyDown={event => {
    if (event.key === "Escape" && mapDrag.current) { event.preventDefault(); event.stopPropagation(); cancelMapDrag(); return; }
    if (event.key === "Escape" && (selectedNode || selectedLink)) { event.preventDefault(); dismissSelection(); event.stopPropagation(); }
  }}>
    {!boardPicker && <div className="fd-assembly-view-menu fd-assembly-view-switch" role="group" aria-label="Project view"><button aria-current="page" onClick={fit}>Connections</button><button onClick={() => setAssemblyViewOpen(true)}>3D assembly</button></div>}
    <Dialog open={assemblyViewOpen} onClose={() => setAssemblyViewOpen(false)} title="3D assembly" className="fd-review-integration-dialog"><div className="fd-review-integration-status" role="status">Integration pending</div><section><h3>See the assembled system</h3><p>The assembled 3D scene is not connected in this build. Individual board models remain available. This connection map uses logical positions and does not establish installed positions or physical fit.</p><Button disabled>Open assembled scene</Button></section><div className="fd-review-integration-actions"><Button size="sm" onClick={() => { if (useUiStore.getState().activeProjectId !== projectId) return; setAssemblyViewOpen(false); const ui = useUiStore.getState(); ui.setWorkspaceArea("outputs"); ui.setWorkspaceTab("3d"); }}>Review board models</Button></div></Dialog>
    <header className="fd-assembly-heading"><h1 title={name}>{boardPicker ? "Choose a board" : "Project overview"}</h1><p>{scene.nodes.length} {scene.nodes.length === 1 ? "board" : "boards"}{data.sources.length !== scene.nodes.length && <> · {data.sources.length} source designs</>} · {scene.links.length} {scene.links.length === 1 ? "connection" : "connections"}</p><small>{failed ? "Project refresh unavailable" : checking ? "Checking project sources…" : "Declared connections · compatibility unverified"}</small>{boardPicker && savedBoard && !restored && !detail && <small role="status" className="fd-assembly-restore-notice">Project definition changed or board unavailable. Select a board again.</small>}</header>
    {failed ? <Button className="fd-assembly-update" size="sm" variant="ghost" onClick={onRetry}>Retry project refresh</Button> : sourcesToReview.length > 0 && <Button className="fd-assembly-update" size="sm" variant="ghost" disabled={checking} onClick={event => { const next = nextAssemblyReviewSelection(data, sourcesToReview, selected), node = next ? scene.nodes.find(node => node.instance.id === next.instanceId) : null; if (node) { choose(node); fit(); focusToolsFrom(event.currentTarget, `board:${node.instance.id}`); } }}><Icon name="warning" width={16} height={16} />{sourcesToReview.length > 1 && selected && ownership !== "stale" && sourcesToReview.includes(selected.sourceId) ? "Next source to review" : "Sources to review"} · {sourcesToReview.length}</Button>}
    <div ref={viewport} className="fd-assembly-viewport" tabIndex={0} aria-label="Assembly canvas. Drag boards to arrange this device’s project map; drag the background to pan; scroll to zoom. Select a board to show its tools." onKeyDown={event => {
      if (event.target !== event.currentTarget) return;
      if (event.key === "Home") { event.preventDefault(); fit(); }
      if (event.key === "+" || event.key === "=") zoom(1.25);
      if (event.key === "-") zoom(.8);
      const offset = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key];
      if (offset) { event.preventDefault(); setCamera(previous => ({ ...previous, x: previous.x + offset[0]! * previous.width * .1, y: previous.y + offset[1]! * previous.height * .1 })); }
    }} onPointerDown={event => {
      if (event.button !== 0 || (event.target as Element).closest("[data-assembly-node], [data-assembly-link]")) return;
      event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, camera: cameraRef.current }; setSelected(null); setLinkId(null);
    }} onPointerMove={event => {
      const start = drag.current; if (!start || event.pointerId !== start.pointerId) return;
      const rect = event.currentTarget.getBoundingClientRect();
      setCamera({ ...start.camera, x: start.camera.x - (event.clientX - start.clientX) / rect.width * start.camera.width, y: start.camera.y - (event.clientY - start.clientY) / rect.height * start.camera.height });
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
      <svg ref={svg} viewBox={`${camera.x} ${camera.y} ${camera.width} ${camera.height}`} width="100%" height="100%" aria-label="Declared board connections">
        {scene.links.map(({ connection, a, b }) => {
          const shape = assemblyLinkShape(a, b);
          return <g key={connection.id} ref={element => { if (element) linkElements.current.set(connection.id, element); else linkElements.current.delete(connection.id); }} data-assembly-link={connection.id} role="button" tabIndex={0} aria-label={`${connection.name}. ${a.instance.name} ${connection.a.connector} to ${b.instance.name} ${connection.b.connector}. Compatibility unverified.`} aria-pressed={linkId === connection.id} onClick={() => { setLinkId(connection.id); setLinkHash(data.manifestSha256); setSelected(null); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setLinkId(connection.id); setLinkHash(data.manifestSha256); setSelected(null); focusToolsFrom(event.currentTarget, `link:${connection.id}`); } }}>
            <path className="fd-assembly-link-hit" d={shape.path} /><path className="fd-assembly-link" data-selected={linkId === connection.id} d={shape.path} /><circle className="fd-assembly-port" cx={shape.start.x} cy={shape.start.y} r={5} /><circle className="fd-assembly-port" cx={shape.end.x} cy={shape.end.y} r={5} />
          </g>;
        })}
        {scene.nodes.map(node => {
          const imageCandidates = overviewBoardImages(projectFiles.data?.files ?? [], { sources: data.sources, sourceId: node.instance.sourceId });
          const preview = previewById.get(node.instance.sourceId), warning = sourcesToReview.includes(node.instance.sourceId), status = node.source?.status;
          const check = checkById.get(node.instance.sourceId), checkWarning = !checks.isFetching && !checks.isError && assemblyCheckNeedsReview(check);
          const model = modelById.get(node.instance.sourceId), modelWarning = !models.isFetching && !models.isError && assemblyModelNeedsReview(model);
          const text = modelWarning ? assemblyModelSummaryLabel(model) : checkWarning ? assemblyCheckSummaryLabel(check) : status !== "available" ? status === "unresolved" ? "Source not imported" : status === "blocked" ? "Source needs review" : "Source missing" : imageCandidates[0] && imageCandidates[0].kind !== "pcb" ? "Saved image · freshness unverified" : previewCopy(preview?.data, preview?.isFetching ?? false, preview?.isError ?? false, !!node.source?.previewPath);
          return <g key={node.instance.id} ref={element => { if (element) nodeElements.current.set(node.instance.id, element); else nodeElements.current.delete(node.instance.id); }} data-assembly-node={node.instance.id} className="fd-assembly-node" transform={`translate(${node.x},${node.y})`} role="button" tabIndex={0} aria-label={`${node.instance.name}. Source ${node.source?.source.name ?? node.instance.sourceId}. ${text}. Select to show tools. Drag to arrange the map; Alt or Option plus arrows to nudge.`} aria-pressed={selected?.instanceId === node.instance.id} onPointerDown={event => beginMapDrag(event, node)} onPointerMove={moveMapDrag} onPointerUp={finishMapDrag} onPointerCancel={cancelMapDrag} onLostPointerCapture={cancelMapDrag} onClick={() => choose(node)} onKeyDown={event => {
              const offset = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, number[]>)[event.key];
              if (event.altKey && offset) {
                event.preventDefault(); event.stopPropagation(); if (unavailable) return;
                const step = event.shiftKey ? 10 : 1;
                useUiStore.getState().setAssemblyMapPosition(layoutKey, projectId, node.instance.id, { units: "canvas-px", sourceId: node.instance.sourceId, x: mapCoordinate(node.x + offset[0]! * step), y: mapCoordinate(node.y + offset[1]! * step) }); return;
              }
              if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(node); focusToolsFrom(event.currentTarget, `board:${node.instance.id}`); }
            }}>
            <title>{node.instance.name} — {node.source?.source.name ?? node.instance.sourceId}. {text}</title>
            <rect className="fd-assembly-card" data-selected={selected?.instanceId === node.instance.id} data-unavailable={status !== "available"} width={node.width} height={node.height} rx={12} />
            <BoardImage projectId={projectId} node={node} candidates={imageCandidates} />
            <text className="fd-assembly-node-title" x={12} y={node.height - 36}>{shortened(node.instance.name, 26)}</text>
            {warning && <rect className="fd-assembly-node-warning" x={10} y={node.height - 27} width={node.width - 20} height={23} rx={6} />}
            <text className="fd-assembly-node-note" data-warning={warning} x={12} y={node.height - 11}>{shortened(text, 34)}</text>
          </g>;
        })}
      </svg>
    </div>
    {(selectedNode || selectedLink) && <div ref={tools} style={toolStyle} className="fd-assembly-context" data-testid="assembly-context-tools" data-context-selection={selectedNode ? `board:${selectedNode.instance.id}` : selectedLink ? `link:${selectedLink.connection.id}` : ""}>
      {selectedNode ? <><strong title={selectedNode.instance.name}>{shortened(selectedNode.instance.name, 24)}</strong>{ownership !== "unavailable" && <Button size="sm" variant="ghost" disabled={unavailable || ownership !== "owned"} onClick={() => inspect(selectedNode)}><Icon name="pcb" width={16} height={16} />Open board</Button>}<Button size="sm" variant="ghost" disabled={unavailable || ownership === "stale"} onClick={() => askAbout(selected, selectedNode.instance.name, ownership === "owned")}><Icon name="sparkles" width={16} height={16} />{ownership === "unavailable" ? "Resolve source" : "Ask"}</Button><WorkspaceMenu key={selectedNode.instance.id} className={`fd-assembly-more ${Number(toolStyle.top) > 300 ? "fd-assembly-more-above" : ""}`} label={<><span>{ownership === "unavailable" ? "Source details" : "More"}</span><Icon name="chevronDown" width={14} height={14} /></>}>{ownership === "unavailable" ? <><div className="fd-assembly-source-details"><strong>{selectedNode.instance.name}</strong><p>{selectedNode.source?.reason ?? "Resolve this source before opening its PCB"}</p></div><Button size="sm" variant="ghost" disabled={unavailable || !selected || selected.manifestSha256 !== data.manifestSha256} onClick={() => { if (useUiStore.getState().activeProjectId === projectId && selected?.manifestSha256 === data.manifestSha256) useUiStore.getState().openProjectFile(ASSEMBLY_MANIFEST_PATH); }}><Icon name="folderOpen" width={16} height={16} />Open project definition</Button>{selectedNode.source && <dl className="fd-assembly-source-details"><dt>Source ID</dt><dd>{selectedNode.source.source.id}</dd>{selectedNode.source.source.location === "project" && <><dt>Project folder</dt><dd>{selectedNode.source.source.directory}</dd></>}{selectedNode.source.source.provenance && <><dt>Declared origin · unverified</dt><dd>{selectedNode.source.source.provenance.repository}</dd><dd>{selectedNode.source.source.provenance.ref}</dd><dd>{selectedNode.source.source.provenance.path}</dd></>}</dl>}</> : <Button size="sm" variant="ghost" disabled={unavailable || ownership !== "owned"} onClick={() => { if (!selected || ownership !== "owned") return; const ui = useUiStore.getState(); ui.setAssemblyBoard(selected); ui.setBoardTab("drc"); }}>PCB checks</Button>}{ownership === "owned" && <Button size="sm" variant="ghost" disabled={unavailable} onClick={() => { if (!selected || ownership !== "owned") return; const ui = useUiStore.getState(); ui.setAssemblyBoard(selected); ui.setBoardTab("3d"); }}>3D model</Button>}{ownership === "owned" && (!selectedNode.source?.previewPath || previewById.get(selectedNode.instance.sourceId)?.data !== "matches-source" || update.state.status === "running" && updateSourceId === selectedNode.instance.sourceId) && <Button size="sm" variant="ghost" disabled={unavailable || update.state.status === "running" || !!previewById.get(selectedNode.instance.sourceId)?.isFetching} onClick={() => void updatePreview(selectedNode)}>{update.state.status === "running" && updateSourceId === selectedNode.instance.sourceId ? "Updating preview…" : selectedNode.source?.previewPath ? "Update preview" : "Create preview"}</Button>}{scene.nodes.filter(node => node.instance.sourceId === selectedNode.instance.sourceId).length > 1 && <p className="fd-menu-caption">Shared design · {scene.nodes.filter(node => node.instance.sourceId === selectedNode.instance.sourceId).length} boards</p>}</WorkspaceMenu>{ownership === "stale" && <span>Project changed · select again</span>}{update.state.error && updateSourceId === selectedNode.instance.sourceId && <span role="alert">{update.state.error}</span>}</> : selectedLink && <><strong title={selectedLink.connection.name}>{shortened(selectedLink.connection.name, 22)}</strong><Button size="sm" variant="ghost" aria-label={`${selectedLink.a.source?.status === "available" ? "Open board" : "Show source tools"}: ${selectedLink.a.instance.name} · ${selectedLink.connection.a.connector}`} title={`${selectedLink.a.instance.name} · ${selectedLink.connection.a.connector}${selectedLink.a.source?.status === "available" ? "" : " · Source unavailable"}`} disabled={unavailable || linkStale} onClick={event => followEndpoint(selectedLink.a, event.currentTarget)}>{shortened(selectedLink.a.instance.name, 15)} · {selectedLink.connection.a.connector}</Button><span>↔</span><Button size="sm" variant="ghost" aria-label={`${selectedLink.b.source?.status === "available" ? "Open board" : "Show source tools"}: ${selectedLink.b.instance.name} · ${selectedLink.connection.b.connector}`} title={`${selectedLink.b.instance.name} · ${selectedLink.connection.b.connector}${selectedLink.b.source?.status === "available" ? "" : " · Source unavailable"}`} disabled={unavailable || linkStale} onClick={event => followEndpoint(selectedLink.b, event.currentTarget)}>{shortened(selectedLink.b.instance.name, 15)} · {selectedLink.connection.b.connector}</Button><span>{linkStale ? "Project changed · select again" : "Unverified"}</span></>}
      <button className="fd-assembly-dismiss" aria-label="Deselect assembly item" onClick={dismissSelection}><Icon name="close" width={15} height={15} /></button>
    </div>}
    <div className="fd-assembly-camera" aria-label="Assembly view controls"><Button ref={fitButton} size="sm" variant="ghost" onClick={fit}>Fit</Button><Button size="sm" variant="ghost" aria-label="Zoom out assembly" onClick={() => zoom(.8)}>−</Button><span>{Math.round(dimensions.current.width / camera.width * 100)}%</span><Button size="sm" variant="ghost" aria-label="Zoom in assembly" onClick={() => zoom(1.25)}>+</Button>{savedPositions.size > 0 && <Button size="sm" variant="ghost" aria-label="Reset map layout" title="Restore this device’s map to the project’s declared arrangement" onClick={resetMapLayout}>Reset layout</Button>}</div>
    <p className="fd-assembly-caption">{update.state.status === "running" ? "Updating the selected source preview…" : "Drag boards to arrange · Layout is a project map, not installed positions"}</p>
  </div>;
}

function AssemblyBoardDetail({ projectId, detail, current, checking, failed, onBack }: { projectId: string; detail: Detail; current: ProjectBoardSources; checking: boolean; failed: boolean; onBack: () => void }) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (useUiStore.getState().activeProjectId === projectId && document.activeElement === document.body) title.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [projectId, detail.selection.instanceId, detail.selection.sourceId, detail.selection.manifestSha256]);
  const owned = assemblySelectionState(current, detail.selection) === "owned", enabled = owned && !checking && !failed;
  const update = useRunTool(), updating = update.state.status === "running";
  const [nativeBusy, setNativeBusy] = useState(false), busyRef = useRef(false);
  const onNativeBusy = (value: boolean) => { busyRef.current = value; setNativeBusy(value); };
  const editing = current.editing === "explicit-source-tools";
  const board = { sourceId: detail.selection.sourceId, manifestSha256: detail.selection.manifestSha256 };
  const inspection = useAssemblyBoardInspection(projectId, board, enabled);
  const source = current.sources.find(row => row.source.id === detail.selection.sourceId);
  const previewPath = owned && source?.source.location === "project" && source.source.directory === detail.directory ? source.previewPath ?? null : detail.previewPath;
  const preview = useProjectText(projectId, previewPath);
  const revision = usePcbPreviewRevision(projectId, enabled && !!previewPath, detail.directory);
  const bounds = inspection.data?.outlineBounds;
  const detailTab = useUiStore(state => state.boardTab);
  const modelView = detailTab === "3d", schematicView = detailTab === "schematic", pcbView = !modelView && !schematicView;
  const finding = useUiStore(state => state.assemblyFinding);
  const requestedFinding = finding?.selection.projectId === projectId && finding.selection.instanceId === detail.selection.instanceId && finding.selection.sourceId === board.sourceId ? finding : null;
  const receipt = useProjectText(projectId, requestedFinding ? (detail.directory === "." ? "" : `${detail.directory}/`) + PCB_PREVIEW_REVISION_PATH : null);
  const [verifiedFindingPreview, setVerifiedFindingPreview] = useState<{ svg: string; receipt: string; sha: string } | null>(null);
  useEffect(() => {
    let active = true;
    if (requestedFinding && preview.data && receipt.data) {
      const svg = preview.data, text = receipt.data, sha = requestedFinding.sourceSha256;
      void assemblyFindingPreviewMatches(svg, text, sha).then(matches => { if (active) setVerifiedFindingPreview(matches ? { svg, receipt: text, sha } : null); }).catch(() => { if (active) setVerifiedFindingPreview(null); });
    }
    return () => { active = false; };
  }, [preview.data, receipt.data, requestedFinding?.sourceSha256]);
  const findingReady = requestedFinding && enabled && !updating && !preview.isFetching && !preview.isError && !receipt.isFetching && !receipt.isError && !revision.isFetching && !revision.isError && revision.data === "matches-source" && assemblyCheckFindingOwned(current, requestedFinding) && verifiedFindingPreview?.svg === preview.data && verifiedFindingPreview?.receipt === receipt.data && verifiedFindingPreview?.sha === requestedFinding.sourceSha256;
  const findingBox = preview.data ? parseSvgViewBox(preview.data) : null;
  const findingVisible = findingReady && findingBox && requestedFinding.point.x >= findingBox.x && requestedFinding.point.x <= findingBox.x + findingBox.width && requestedFinding.point.y >= findingBox.y && requestedFinding.point.y <= findingBox.y + findingBox.height;
  const dismissFinding = () => useUiStore.getState().dismissAssemblyFinding();
  const sourceNote = !owned ? "Project definition changed. Return to the overview and select this board again." : failed ? "Could not refresh project ownership. Recheck the overview before inspecting." : previewCopy(revision.data, revision.isFetching || checking, revision.isError, !!previewPath);
  return <div className="fd-assembly-detail" data-view={schematicView ? "schematic" : modelView ? "model" : "pcb"} data-testid="assembly-board-detail" onKeyDown={event => { if (event.key === "Escape" && requestedFinding && !nativeBusy) { event.stopPropagation(); dismissFinding(); } }}>
    <div className="fd-assembly-detail-heading"><div className="fd-assembly-board-switch"><h1 ref={title} tabIndex={-1} className="fd-assembly-board-title sr-only">{detail.instanceName}</h1><WorkspaceMenu className="fd-assembly-board-picker" label={<><span aria-label="Switch board">{detail.instanceName}</span><Icon name="chevronDown" width={16} height={16} /></>}><button disabled={nativeBusy} onClick={() => { if (!busyRef.current) onBack(); }}>← All boards</button><div className="fd-menu-divider" /><div className="fd-menu-caption">Switch board</div>{current.assembly?.instances.map(instance => {
      const selection = captureAssemblySelection(current, instance.id), available = selection && assemblySelectionState(current, selection) === "owned", selected = instance.id === detail.selection.instanceId;
      return <button key={instance.id} aria-current={selected ? "true" : undefined} disabled={!enabled || nativeBusy || updating || !available || selected} title={!available ? "Source unavailable; resolve it from the project overview" : undefined} onClick={() => {
        if (!enabled || busyRef.current || updating || !selection || assemblySelectionState(current, selection) !== "owned" || useUiStore.getState().activeProjectId !== projectId) return;
        useUiStore.getState().setAssemblyBoard(selection);
      }}><span>{instance.name}{!available && <small>Source unavailable</small>}</span>{selected && <Icon name="check" width={15} height={15} />}</button>;
    })}{(nativeBusy || updating) && <p className="fd-menu-caption">Finish the current board operation before switching.</p>}</WorkspaceMenu></div><BoardViewTabs value={schematicView ? "schematic" : modelView ? "3d" : "pcb"} disabled={nativeBusy} onChange={tab => useUiStore.getState().setWorkspaceTab(tab)} /><CanvasToolButton label="Ask about this board" icon="sparkles" disabled={!enabled} onClick={() => askAbout(detail.selection, detail.instanceName, true)} /><div className="fd-board-task-actions"><Button size="sm" disabled title="Routing individual assembly sources is not connected yet"><Icon name="route" width={18} height={18} />Routing</Button><Button size="sm" disabled={!enabled || nativeBusy || updating} onClick={() => { if (useUiStore.getState().activeProjectId !== projectId || !enabled) return; const ui = useUiStore.getState(); ui.setAssemblyBoard(detail.selection); ui.setBoardTab("drc"); }}><Icon name="checkCircle" width={18} height={18} />Checks</Button></div></div>
    <div className="fd-assembly-pcb-surface" hidden={!pcbView}>
    <div className="fd-assembly-detail-status"><span data-warning={!owned || failed || ["source-changed", "artifact-changed"].includes(revision.data ?? "")}>{sourceNote}</span>{owned && (updating || !previewPath || revision.data !== "matches-source") && <Button size="sm" variant="ghost" disabled={!enabled || updating || nativeBusy || revision.isFetching} onClick={() => void update.run("render_pcb_svg", { projectId, board })}>{updating ? "Updating preview…" : previewPath ? "Update preview" : "Create preview"}</Button>}{inspection.isFetching ? <span>Inspecting native source…</span> : inspection.isError ? <Button size="sm" variant="ghost" disabled={!enabled} onClick={() => void inspection.refetch()}>Could not inspect source · Retry</Button> : owned && !failed && inspection.data && <span>{inspection.data.partCount} parts{bounds ? ` · ${+(bounds.maxX - bounds.minX).toFixed(3)} × ${+(bounds.maxY - bounds.minY).toFixed(3)} mm` : " · outline dimensions unverified"}</span>}</div>
    {requestedFinding && <div className="fd-assembly-finding-summary" role="status"><div><strong>{requestedFinding.description}</strong><span>{findingVisible ? `${requestedFinding.itemDescription} · ${requestedFinding.point.x.toFixed(3)}, ${requestedFinding.point.y.toFixed(3)} mm` : findingReady ? "This finding is outside the saved preview. Its position is not shown." : "Location hidden until the saved PCB, project definition and displayed preview match this finding."}</span></div><div className="fd-assembly-finding-actions"><Button size="sm" disabled={!findingReady || nativeBusy} onClick={() => {
      const ui = useUiStore.getState();
      if (!findingReady || nativeBusy || ui.activeProjectId !== projectId || ui.assemblyFinding !== requestedFinding) return;
      askAboutSurface({ projectId, label: `${detail.instanceName} / PCB finding`, priority: 25, details: JSON.stringify({ board, instance: detail.selection.instanceId, directory: detail.directory, finding: { description: requestedFinding.description, item: requestedFinding.itemDescription, pointMm: requestedFinding.point, recordedSourceSha256: requestedFinding.sourceSha256 }, locationVerified: !!findingVisible, instruction: "Inspect the latest saved source and PCB-only report. Source may be shared. Explain the cause and proposed fix before editing; this is not schematic parity or an electrical pass." }) }, `Explain this finding on ${detail.instanceName}: ${requestedFinding.description}. What should I check before fixing it?`);
    }}>Ask about finding</Button><Button size="sm" variant="ghost" disabled={nativeBusy} onClick={() => {
      const ui = useUiStore.getState();
      if (ui.activeProjectId === projectId && ui.assemblyFinding === requestedFinding) ui.setBoardTab("drc");
    }}>Back to checks</Button><Button autoFocus size="sm" variant="ghost" onClick={dismissFinding}>Dismiss finding</Button></div></div>}
    {preview.isError ? <LoadError title="Could not load this board’s saved preview" onRetry={() => void preview.refetch()} /> : previewPath && preview.isPending ? <div className="flex h-full items-center justify-center"><Spinner /></div> : preview.data ? parseSvgViewBox(preview.data) ? <AssemblyPcbDrawing key={`${projectId}/${board.sourceId}/${board.manifestSha256}`} projectId={projectId} board={board} directory={detail.directory} svg={preview.data} visible={pcbView} findingPoint={findingVisible ? requestedFinding.point : null} onDismissFinding={dismissFinding} canSelect={editing && enabled} canPosition={editing && enabled && !updating && revision.data === "matches-source" && !revision.isFetching && !revision.isError} onBusyChange={onNativeBusy} /> : <div className="fd-assembly-safe-preview"><ProjectImage projectId={projectId} path={previewPath!} alt={`${detail.instanceName} saved PCB preview`} /><p>Saved preview · drawing coordinates unverified</p></div> : <EmptyState title="No saved PCB preview">Create a preview to see this saved board here. Its native source details appear above.</EmptyState>}
    {update.state.error && <p role="alert" className="fd-assembly-detail-error">{update.state.error}</p>}
    </div>
    {schematicView && <AssemblySchematicPreview key={`${projectId}/${board.sourceId}/${board.manifestSha256}`} projectId={projectId} data={current} selection={detail.selection} enabled={enabled} onBusyChange={onNativeBusy} />}
    {modelView && <AssemblyBoardModel key={`${projectId}/${board.sourceId}/${board.manifestSha256}`} projectId={projectId} data={current} selection={detail.selection} enabled={enabled} />}
    <p className="fd-assembly-detail-note">Source: {detail.sourceName}{owned && (current.assembly?.instances.filter(instance => instance.sourceId === detail.selection.sourceId).length ?? 0) > 1 ? ` · Shared by ${current.assembly!.instances.filter(instance => instance.sourceId === detail.selection.sourceId).length} boards` : ""} · Schematic, connection and fit checks unverified</p>
  </div>;
}


/** Source-bound location tools and pins stored beside the selected native source. */
function AssemblyPcbDrawing({ projectId, board, directory, svg, canPosition, canSelect, findingPoint, onDismissFinding, visible, onBusyChange }: { projectId: string; board: BoardSourceSelection; directory: string; svg: string; visible: boolean; findingPoint: { x: number; y: number } | null; onDismissFinding: () => void; canPosition: boolean; canSelect: boolean; onBusyChange: (busy: boolean) => void }) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null), [busy, setBusy] = useState(false);
  const busyRef = useRef(false), nativeCoordinates = pcbSvgHasNativeCoordinates(svg);
  const comments = useSourceCommentTools({ projectId, board, directory, enabled: canSelect, canPin: canPosition && nativeCoordinates && !busy, visible });
  const mutationBusy = (value: boolean) => { busyRef.current = value; setBusy(value); onBusyChange(value); };
  return <>{comments.dialog}<SvgViewer svg={svg} viewKey={`${projectId}/${board.sourceId}/${directory}`} toolbar={comments.toolbar}
    onDrawingEscape={() => { if (!point || busyRef.current) return false; setPoint(null); return true; }}
    {...(canSelect && nativeCoordinates ? { onDrawingClick: (next: { x: number; y: number }) => { if (!busyRef.current) { onDismissFinding(); setPoint(next); } } } : {})}
    overlay={box => <>{nativeCoordinates && comments.overlay(box)}{findingPoint && box ? <div data-canvas-tools className="fd-location-anchor fd-finding-anchor" style={{ left: `${(findingPoint.x - box.x) / box.width * 100}%`, top: `${(findingPoint.y - box.y) / box.height * 100}%` }}>
      <span className="fd-location-marker" /><div className="fd-location-toolbar" role="group" aria-label="PCB check finding location" style={{ transform: `translateX(${(findingPoint.x - box.x) / box.width < .25 ? "0" : (findingPoint.x - box.x) / box.width > .75 ? "-100%" : "-50%"})`, ...((findingPoint.y - box.y) / box.height < .15 ? { top: 20, bottom: "auto" } : {}) }}><span>Check finding · {findingPoint.x.toFixed(3)}, {findingPoint.y.toFixed(3)} mm</span><button className="fd-assembly-dismiss" aria-label="Dismiss PCB check finding" onClick={onDismissFinding}><Icon name="close" width={15} height={15} /></button></div>
    </div> : point && box && <div data-canvas-tools className="fd-location-anchor" style={{ left: `${(point.x - box.x) / box.width * 100}%`, top: `${(point.y - box.y) / box.height * 100}%` }}>
      <span className="fd-location-marker" />
      <div className="fd-location-toolbar" aria-label="Selected board source location" style={{ transform: `translateX(${(point.x - box.x) / box.width < .25 ? "0" : (point.x - box.x) / box.width > .75 ? "-100%" : "-50%"})` }}>
        <span>{point.x.toFixed(1)}, {point.y.toFixed(1)} mm</span>
        <Button size="sm" variant="ghost" disabled={!comments.ready || !canPosition || busy} onClick={() => comments.pinAt(point)}><Icon name="pin" width={14} height={14} />Pin comment</Button>
        <NativePartTools visible={visible} board={board} projectId={projectId} point={point} box={box} canPosition={canPosition && nativeCoordinates} openAbove={(point.y - box.y) / box.height > .5} onMoved={setPoint} onMutationBusyChange={mutationBusy} />
        <button className="fd-assembly-dismiss" disabled={busy} aria-label="Deselect board source location" onClick={event => { if (busyRef.current) return; const drawing = event.currentTarget.closest<HTMLElement>(".fd-svg-host"); setPoint(null); requestAnimationFrame(() => drawing?.focus({ preventScroll: true })); }}><Icon name="close" width={15} height={15} /></button>
      </div>
    </div>}</>} /></>;
}
