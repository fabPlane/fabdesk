import { useEffect, useRef, useState } from "react";
import type { PcbOutlineInspection } from "@fabdesk/protocol";
import { inspectPcbOutline, pcbToolJson, resizedOutlinePoints, useCoreClient, usePcbOutline, useRunTool } from "@fabdesk/client-core";
import { Button, Input, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";

/** Dimensions edit the owned Edge.Cuts only; no footprint, route, or enclosure is scaled. */
export function NativeOutlinePanel({ projectId, canPosition, onBusyChange }: { projectId: string; canPosition: boolean; onBusyChange: (busy: boolean) => void }) {
  const client = useCoreClient(), preview = useRunTool(), inspection = usePcbOutline(projectId, true);
  const [snapshot, setSnapshot] = useState<PcbOutlineInspection | null>(null);
  const [width, setWidth] = useState(""), [height, setHeight] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [exportError, setExportError] = useState<string | null>(null);
  const inFlight = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const choose = (data: PcbOutlineInspection) => {
    setSnapshot(data); setWidth(data.bounds ? String(data.bounds.maxX - data.bounds.minX) : ""); setHeight(data.bounds ? String(data.bounds.maxY - data.bounds.minY) : ""); setError(null); setNotice(null); setExportError(null);
  };
  useEffect(() => { if (inspection.data && !snapshot) choose(inspection.data); }, [inspection.data, snapshot]);
  const stale = !!snapshot && !!inspection.data && snapshot.sourceSha256 !== inspection.data.sourceSha256;
  const points = resizedOutlinePoints(snapshot?.bounds ?? null, width, height);
  const changed = !!snapshot && !!points && (!snapshot.bounds || Number(width) !== snapshot.bounds.maxX - snapshot.bounds.minX || Number(height) !== snapshot.bounds.maxY - snapshot.bounds.minY);
  const reload = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); onBusyChange(true); setError(null);
    try { const data = await inspectPcbOutline(client, projectId); if (mounted.current) choose(data); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not inspect this outline."); }
    finally { inFlight.current = false; onBusyChange(false); if (mounted.current) setBusy(false); }
  };
  const apply = async () => {
    if (inFlight.current || !snapshot?.editable || !points || !changed || stale || !canPosition || inspection.isFetching || inspection.isError) return;
    inFlight.current = true; setBusy(true); onBusyChange(true); setError(null); setNotice(null); setExportError(null);
    let saved = false;
    try {
      const result = pcbToolJson(await client.callTool("pcb_define_outline", { projectId, points, replace: !!snapshot.bounds, expectedSourceSha256: snapshot.sourceSha256 }));
      if (result.saved !== true) throw Error("The native tool did not confirm a saved outline.");
      saved = true;
      const rendered = await preview.run("render_pcb_svg", { projectId });
      const data = await inspectPcbOutline(client, projectId);
      if (mounted.current) {
        choose(data);
        setNotice("Board outline saved. Parts and routed copper stayed in place. Review edge clearances, routing and the enclosure before exporting.");
        if (rendered.status === "failed") setExportError(rendered.error ?? "The preview could not refresh and remains out of date.");
      }
    } catch (failure) { if (mounted.current) setError(`${saved ? "The outline was saved, but refresh could not finish." : "Could not resize this outline."} Reload before retrying. ${failure instanceof Error ? failure.message : ""}`); }
    finally { inFlight.current = false; onBusyChange(false); if (mounted.current) setBusy(false); }
  };
  if (!snapshot) return inspection.isError ? <p role="alert">Could not inspect the saved outline. <Button size="sm" onClick={() => void inspection.refetch()}>Retry</Button></p> : <div className="flex items-center gap-2 text-muted"><Spinner />Inspecting saved outline…</div>;
  return <>
    {inspection.isError && <p role="alert" className="fd-native-part-warning">The latest outline inspection failed. Reload before applying dimensions.</p>}
    {!snapshot.editable ? <><p className="fd-native-part-note">{snapshot.reason}</p><Button size="sm" variant="ghost" disabled={busy} onClick={() => void reload()}>Reload outline</Button></> : <>
      <p className="fd-native-part-note">{snapshot.bounds ? `Resize the rectangular outline from its top-left corner at (${snapshot.bounds.minX}, ${snapshot.bounds.minY}) mm.` : "This PCB has no outline yet. Enter its width and height; the top-left corner will be at KiCad (0, 0)."} Parts, traces and mechanical models keep their current positions.</p>
      {stale && <p role="status" className="fd-native-part-warning">The PCB changed. Reload its outline before applying dimensions. Your typed values are kept.</p>}
      {!canPosition && !busy && <p className="fd-native-part-warning">Update the PCB preview before applying dimensions.</p>}
      <form onSubmit={event => { event.preventDefault(); void apply(); }}>
        <div className="fd-native-outline-fields">
          <label>Width (mm)<Input type="number" min="0.000001" max="1000" step="any" aria-label="Board width (mm)" value={width} disabled={busy} onChange={event => setWidth(event.target.value)} /></label>
          <label>Height (mm)<Input type="number" min="0.000001" max="1000" step="any" aria-label="Board height (mm)" value={height} disabled={busy} onChange={event => setHeight(event.target.value)} /></label>
        </div>
        <div className="fd-native-part-actions"><Button size="sm" variant="ghost" disabled={busy} onClick={() => void reload()}>Reload outline</Button><Button size="sm" variant="primary" type="submit" disabled={busy || stale || !canPosition || inspection.isFetching || inspection.isError || !points || !changed}>{busy ? "Saving / refreshing…" : snapshot.bounds ? "Apply dimensions" : "Create outline"}</Button></div>
      </form>
    </>}
    {notice && <p role="status" className="fd-native-part-warning">{notice}<Button size="sm" variant="ghost" onClick={() => useUiStore.getState().setBoardTab("drc")}>Open checks</Button></p>}
    {exportError && <details className="fd-native-part-note"><summary>Preview remains out of date</summary><p>{exportError}</p><p>Resolve the export error, then choose Update preview. The outline is already saved.</p></details>}
    {error && <p role="alert" className="fd-native-part-warning">{error}</p>}
  </>;
}
