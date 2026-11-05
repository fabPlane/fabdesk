import { DisclosureSummary } from "../components/DisclosureSummary";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NativePartTarget } from "./NativePartTarget";
import { BoardChecksButton } from "./BoardChecksButton";
import type { SvgBox } from "./svg-coords";
import { PcbOutlineResizeResult, type PcbOutlineInspection, type BoardSourceSelection } from "@fabdesk/protocol";
import { inspectPcbOutline, pcbToolJsonForSource, outlineDimensionInput, resizedOutlinePoints, useCoreClient, usePcbOutline, useRunTool, useToolManifest } from "@fabdesk/client-core";
import { Button, Input, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";

type OutlineRecovery = { bounds: NonNullable<PcbOutlineInspection["bounds"]>; edgeIds: string[]; savedSha256: string };

/** Dimensions edit the selected native Edge.Cuts only; no footprint, route, or enclosure is scaled. */
export function NativeOutlinePanel({ projectId, board, canPosition, onBusyChange, host, box, onMutationBusyChange, visible = true }: { board?: BoardSourceSelection; visible?: boolean; onMutationBusyChange: (busy: boolean) => void; projectId: string; canPosition: boolean; onBusyChange: (busy: boolean) => void; host: HTMLElement | null; box: SvgBox }) {
  const client = useCoreClient(), preview = useRunTool(), inspection = usePcbOutline(projectId, true, board), tools = useToolManifest();
  const resizeAvailable = tools.data?.some(tool => tool.name === "pcb_resize_outline") === true;
  const [snapshot, setSnapshot] = useState<PcbOutlineInspection | null>(null);
  const [recovery, setRecovery] = useState<OutlineRecovery | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const [width, setWidth] = useState(""), [height, setHeight] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [exportError, setExportError] = useState<string | null>(null);
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const choose = (data: PcbOutlineInspection, keepRecovery = false) => {
    if (!keepRecovery) setRecovery(null);
    setSnapshot(data); setWidth(data.bounds ? outlineDimensionInput(data.bounds.maxX - data.bounds.minX) : ""); setHeight(data.bounds ? outlineDimensionInput(data.bounds.maxY - data.bounds.minY) : ""); setError(null); setNotice(null); setExportError(null);
  };
  useEffect(() => { if (inspection.data && !snapshot) choose(inspection.data); }, [inspection.data, snapshot]);
  const stale = !!snapshot && !!inspection.data && snapshot.sourceSha256 !== inspection.data.sourceSha256;
  const points = resizedOutlinePoints(snapshot?.bounds ?? null, width, height);
  const changed = !!snapshot && !!points && (!snapshot.bounds || Number(width) !== Number(outlineDimensionInput(snapshot.bounds.maxX - snapshot.bounds.minX)) || Number(height) !== Number(outlineDimensionInput(snapshot.bounds.maxY - snapshot.bounds.minY)));
  const hasProposal = !!snapshot && (width !== (snapshot.bounds ? outlineDimensionInput(snapshot.bounds.maxX - snapshot.bounds.minX) : "") || height !== (snapshot.bounds ? outlineDimensionInput(snapshot.bounds.maxY - snapshot.bounds.minY) : ""));
  const reload = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); onBusyChange(true); setError(null);
    try { const data = await inspectPcbOutline(client, projectId, board); if (mounted.current) choose(data); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not inspect this outline."); }
    finally { inFlight.current = false; onBusyChange(false); if (mounted.current) setBusy(false); }
  };
  const apply = async (reverting = false) => {
    if (inFlight.current || !!board && !snapshot?.bounds || !snapshot?.editable || stale || !canPosition || inspection.isFetching || inspection.isError || !!snapshot.bounds && (!resizeAvailable || !snapshot.edgeIds?.length)) return;
    if (reverting && (!recovery || !snapshot.bounds || hasProposal || recovery.savedSha256 !== snapshot.sourceSha256 || inspection.data?.sourceSha256 !== recovery.savedSha256 || JSON.stringify([...snapshot.edgeIds].sort()) !== JSON.stringify([...recovery.edgeIds].sort()))) return;
    const targetWidth = reverting ? recovery!.bounds.maxX - recovery!.bounds.minX : Number(width), targetHeight = reverting ? recovery!.bounds.maxY - recovery!.bounds.minY : Number(height);
    const targetPoints = resizedOutlinePoints(snapshot.bounds, String(targetWidth), String(targetHeight));
    if (!targetPoints || !reverting && (!points || !changed)) return;
    const previousBounds = snapshot.bounds ? { ...snapshot.bounds } : null, previousEdgeIds = [...snapshot.edgeIds];
    inFlight.current = true; onMutationBusyChange(true); setBusy(true); onBusyChange(true); setError(null); setNotice(null); setExportError(null);
    let saved = false;
    try {
      const result = snapshot.bounds
        ? pcbToolJsonForSource(await client.callTool("pcb_resize_outline", { projectId, ...(board ? { board: { ...board } } : {}), edgeIds: snapshot.edgeIds, widthMm: targetWidth, heightMm: targetHeight, expectedSourceSha256: snapshot.sourceSha256 }), projectId, board)
        : pcbToolJsonForSource(await client.callTool("pcb_define_outline", { projectId, points: targetPoints, expectedSourceSha256: snapshot.sourceSha256 }), projectId, board);
      if (result.saved !== true) throw Error("The native tool did not confirm a saved outline.");
      saved = true; if (mounted.current) setRecovery(null);
      if (snapshot.bounds) PcbOutlineResizeResult.parse(result);
      const rendered = await preview.run("render_pcb_svg", { projectId, ...(board ? { board: { ...board } } : {}) });
      const data = await inspectPcbOutline(client, projectId, board);
      const actual = data.bounds, origin = previousBounds ?? { minX: 0, minY: 0 };
      if (!data.editable || !actual || Math.abs(actual.minX - origin.minX) > .000001 || Math.abs(actual.minY - origin.minY) > .000001 || Math.abs(actual.maxX - actual.minX - targetWidth) > .000001 || Math.abs(actual.maxY - actual.minY - targetHeight) > .000001 || previousBounds && JSON.stringify([...data.edgeIds].sort()) !== JSON.stringify([...previousEdgeIds].sort())) throw Error("The inspected outline does not match the requested saved dimensions and original edges. Review the latest PCB before making another change.");
      if (mounted.current) {
        choose(data);
        if (!reverting && previousBounds) setRecovery({ bounds: previousBounds, edgeIds: previousEdgeIds, savedSha256: data.sourceSha256 });
        setNotice(`${reverting ? "Previous board dimensions restored." : "Board outline saved."} Parts and routed copper stayed in place. Review edge clearances, routing and the enclosure before exporting.`);
        if (rendered.status === "failed") setExportError(rendered.error ?? "The preview could not refresh and remains out of date.");
      }
    } catch (failure) { if (mounted.current) setError(`${saved ? "The outline was saved, but refresh could not finish." : "Could not resize this outline."} Reload before retrying. ${failure instanceof Error ? failure.message : ""}`); }
    finally {
      inFlight.current = false; onMutationBusyChange(false); onBusyChange(false);
      if (mounted.current) { setBusy(false); if (useUiStore.getState().activeProjectId === projectId) requestAnimationFrame(() => { if (useUiStore.getState().activeProjectId === projectId) form.current?.closest<HTMLElement>('[role="dialog"]')?.focus({ preventScroll: true }); }); }
    }
  };
  if (!snapshot) return inspection.isError ? <p role="alert">Could not inspect the saved outline. <Button size="sm" onClick={() => void inspection.refetch()}>Retry</Button></p> : <div className="flex items-center gap-2 text-muted"><Spinner />Inspecting saved outline…</div>;
  const bounds = snapshot.bounds;
  const showTarget = visible && host && bounds && points && snapshot.editable && resizeAvailable && canPosition && !busy && !stale && !inspection.isError && !inspection.isFetching;
  return <>
    {showTarget && <>
      {createPortal(<div className="fd-outline-size-preview" data-canvas-tools style={{ left: `${(bounds.minX - box.x) / box.width * 100}%`, top: `${(bounds.minY - box.y) / box.height * 100}%`, width: `${Number(width) / box.width * 100}%`, height: `${Number(height) / box.height * 100}%` }} />, host)}
      <NativePartTarget host={host} box={box} point={points[2]!} reference="Board" changed={changed} corner constrainToDrawing={false} snapOrigin={{ x: bounds.minX, y: bounds.minY }} ariaLabel="Drag bottom-right board corner to propose width and height. Arrow keys move 0.1 mm; Shift moves 0.01 mm. Apply dimensions to save." targetLabel={`${width} × ${height} mm${changed ? " · preview" : " · drag corner"}`} onMove={end => {
        const dimension = (value: number) => String(Math.round(Math.min(1000, Math.max(.000001, value)) * 1_000_000) / 1_000_000);
        setWidth(dimension(end.x - bounds.minX)); setHeight(dimension(end.y - bounds.minY)); setNotice(null); setError(null); setExportError(null);
      }} />
    </>}
    {inspection.isError && <p role="alert" className="fd-native-part-warning">The latest outline inspection failed. Reload before applying dimensions.</p>}
    {!snapshot.editable ? <><p className="fd-native-part-note">{snapshot.reason}</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => void reload()}>Reload outline</Button></> : !!board && !snapshot.bounds ? <p className="fd-native-part-note">This assembly source needs a complete rectangular outline before it can be resized here. Define or review its boundary in KiCad.</p> : snapshot.bounds && !resizeAvailable ? <p className="fd-native-part-note">{tools.isPending ? "Loading native board tools…" : tools.isError ? "Could not load native board tools." : "This runtime does not support resizing existing native outlines yet. Update the app and its connected runtime."}{tools.isError && <Button size="sm" variant="ghost" onClick={() => void tools.refetch()}>Retry</Button>}</p> : <>
      <p className="fd-native-part-note">{snapshot.bounds ? `Keep top-left corner · (${snapshot.bounds.minX}, ${snapshot.bounds.minY}) mm` : "New outline · top-left corner at KiCad (0, 0)"}</p>
      <p className="fd-native-outline-scope">Outline only. Parts, tracks and mechanical models stay in place.</p>
      {stale && <p role="status" className="fd-native-part-warning">The PCB changed. Reload its outline before applying dimensions. Your typed values are kept.</p>}
      {!canPosition && !busy && <p className="fd-native-part-warning">Update the PCB preview before applying dimensions.</p>}
      <form ref={form} onSubmit={event => { event.preventDefault(); void apply(); }}>
        <div className="fd-native-outline-fields">
          <label>Width (mm)<Input type="number" min="0.000001" max="1000" step="any" aria-label="Board width (mm)" value={width} disabled={busy} onChange={event => setWidth(event.target.value)} /></label>
          <label>Height (mm)<Input type="number" min="0.000001" max="1000" step="any" aria-label="Board height (mm)" value={height} disabled={busy} onChange={event => setHeight(event.target.value)} /></label>
        </div>
        <p className="fd-native-part-note" role="status">{changed && points ? "Preview · not applied" : "Saved dimensions"}. Run checks after applying.</p>
        {hasProposal && !points && <p role="status" className="fd-native-part-warning">Enter width and height between 0.000001 and 1000 mm, or discard this proposal.</p>}
        <div className="fd-native-part-actions">{hasProposal && <Button size="sm" variant="ghost" disabled={busy} onClick={event => { const dialog = event.currentTarget.closest<HTMLElement>('[role="dialog"]'); choose(snapshot, true); requestAnimationFrame(() => dialog?.focus({ preventScroll: true })); }}>Discard proposal</Button>}<Button size="sm" variant="ghost" disabled={busy} onClick={() => void reload()}>Reload outline</Button><Button size="sm" variant="primary" type="submit" disabled={busy || stale || !canPosition || inspection.isFetching || inspection.isError || !points || !changed}>{busy ? "Saving / refreshing…" : snapshot.bounds ? "Apply outline" : "Create outline"}</Button></div>
      </form>
      {recovery && <div><Button size="sm" variant="ghost" disabled={busy || hasProposal || stale || !canPosition || inspection.isFetching || inspection.isError || recovery.savedSha256 !== snapshot.sourceSha256 || inspection.data?.sourceSha256 !== recovery.savedSha256 || JSON.stringify([...snapshot.edgeIds].sort()) !== JSON.stringify([...recovery.edgeIds].sort())} onClick={() => void apply(true)}>Revert last dimensions</Button><p className="fd-native-part-note">Restore {recovery.bounds.maxX - recovery.bounds.minX} × {recovery.bounds.maxY - recovery.bounds.minY} mm using the same outline edges. Available here for this saved PCB snapshot; other edits are not undone.</p></div>}
    </>}
    {notice && <p role="status" className="fd-native-part-warning">{notice}<BoardChecksButton projectId={projectId} {...(board ? { board } : {})} /></p>}
    {exportError && <details className="fd-native-part-note"><DisclosureSummary icon="warning" label="Preview remains out of date" variant="compact" /><p>{exportError}</p><p>Resolve the export error, then choose Update preview. The outline is already saved.</p></details>}
    {error && <p role="alert" className="fd-native-part-warning">{error}</p>}
  </>;
}
