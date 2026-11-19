import type { ArtPlacement,ImageCrop } from "@fabdesk/board-art";
import { pcbSvgHasNativeCoordinates,useLivePreview,usePcbOutline,usePcbPreviewRevision,useProjectText,useRunTool } from "@fabdesk/client-core";
import { Button,EmptyState,LoadError,Spinner } from "../components/ui";
import { ArtPlacementOverlay } from "./ArtPlacementEditor";
import { SvgViewer } from "./SvgViewer";

/** Existing-board preview is source-checked and never paints the standalone art board over the circuit. */
export function ArtSavedBoardPreview({ projectId, enabled, overlayUrl, widthMm, heightMm, crop, placement, lock, placing, busy, silkOnly, marks, onPlace, onFit, onRetrySource }: {
  projectId: string; enabled: boolean; overlayUrl: string | null; widthMm: number; heightMm: number;
  crop: ImageCrop; placement: ArtPlacement | null; lock: boolean; placing: boolean; busy: boolean;
  silkOnly: boolean; marks: number; onRetrySource?: () => void; onPlace: (value: ArtPlacement) => void; onFit: (width: number, height: number) => void;
}) {
  const drawing = useProjectText(projectId, "renders/pcb.svg");
  const outline = usePcbOutline(projectId, enabled);
  const revision = usePcbPreviewRevision(projectId, enabled && !!drawing.data);
  const render = useRunTool();
  const bounds = outline.data?.bounds;
  const nativeWidth = bounds ? bounds.maxX - bounds.minX : null, nativeHeight = bounds ? bounds.maxY - bounds.minY : null;
  const dimensionsMatch = nativeWidth !== null && nativeHeight !== null && Math.abs(widthMm - nativeWidth) < 1e-6 && Math.abs(heightMm - nativeHeight) < 1e-6;
  const checking = outline.isFetching || revision.isFetching || drawing.isFetching;
  const current = enabled && !checking && !outline.isError && !revision.isError && !drawing.isError && revision.data === "matches-source" && !!drawing.data && pcbSvgHasNativeCoordinates(drawing.data);
  const canOverlay = current && !!bounds && dimensionsMatch && silkOnly && !!overlayUrl;
  const livePreview = useLivePreview("pcb", { projectId, enabled });
  const update = () => { void livePreview.retry(); };
  const updating = livePreview.updating;
  if (drawing.isError) return <LoadError title="Could not open the saved PCB preview" onRetry={() => void drawing.refetch()} />;
  if (drawing.isPending) return <div className="flex flex-1 items-center justify-center"><Spinner /></div>;
  if (!drawing.data) return <EmptyState title="Preparing saved PCB preview…" action={livePreview.error ? <Button onClick={update}>Retry preview</Button> : <Spinner />}>The artwork draft is kept. A verified PCB drawing is needed to preview its position on the circuit.{livePreview.error?.message && <p role="alert">{livePreview.error?.message}</p>}</EmptyState>;
  const unverified = revision.data === "source-changed" ? "PCB changed since preview · artwork overlay hidden" : revision.data === "artifact-changed" ? "PCB preview changed outside export · artwork overlay hidden" : "PCB preview unverified · artwork overlay hidden";
  const status = !enabled ? "Board source scope unverified · artwork overlay hidden" : checking ? "Checking saved PCB…" : !current ? unverified : !bounds ? "Saved PCB · Artwork placement unavailable for this boundary" : !silkOnly ? "Saved PCB · Circuit preview supports silkscreen artwork" : !dimensionsMatch ? `Artwork canvas ${widthMm} × ${heightMm} mm · PCB ${+nativeWidth!.toFixed(3)} × ${+nativeHeight!.toFixed(3)} mm` : marks === 0 ? "No visible marks at this size · Try Line hatch or Solid silhouette" : `Proposed silkscreen · ${marks} marks · Not applied`;
  return <div className="fd-art-saved-board" aria-label="Artwork preview on saved PCB">
    <div className="fd-art-pcb-status" role="status" data-warning={!canOverlay || marks === 0}>
      <span>{status}</span>
      {!enabled && onRetrySource && <Button size="sm" onClick={onRetrySource}>Retry source check</Button>}
      {livePreview.error && <Button size="sm" disabled={updating} onClick={update}>Retry preview</Button>}
      {current && bounds && !dimensionsMatch && <Button size="sm" disabled={busy} onClick={() => onFit(nativeWidth!, nativeHeight!)}>Fit artwork to PCB</Button>}
      {outline.isError && <Button size="sm" onClick={() => void outline.refetch()}>Retry boundary check</Button>}
      {revision.isError && <Button size="sm" onClick={() => void revision.refetch()}>Retry preview check</Button>}
    </div>
    {canOverlay && bounds && <p className="fd-art-pcb-origin">Amber marks are a proposal. Artwork positions start at the PCB bounds ({bounds.minX}, {bounds.minY} mm). Clearances and electrical checks are separate.</p>}
    {livePreview.error?.message && <p role="alert" className="px-3 text-xs text-danger">{livePreview.error?.message}</p>}
    <div className="fd-art-pcb-drawing"><SvgViewer svg={drawing.data} viewKey={`${projectId}:artwork-pcb`} overlay={box => canOverlay && bounds && box ? <svg data-canvas-tools className="fd-art-pcb-overlay" viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}>
      <image href={overlayUrl!} x={bounds.minX} y={bounds.minY} width={widthMm} height={heightMm} />
      {placing && placement && <svg x={bounds.minX - 4} y={bounds.minY - 4} width={widthMm + 8} height={heightMm + 8} overflow="visible"><ArtPlacementOverlay crop={crop} value={placement} onChange={onPlace} widthMm={widthMm} heightMm={heightMm} lock={lock} disabled={busy || checking} /></svg>}
    </svg> : null} /></div>
  </div>;
}
