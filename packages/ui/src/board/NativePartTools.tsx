import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { PcbPartPosition } from "@fabdesk/protocol";
import { inspectPcbParts, parsePartPositionInput, pcbPlacementWarnings, pcbToolJson, useCoreClient, usePcbPartsNear, useRunTool } from "@fabdesk/client-core";
import { Button, IconButton, Input, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { NativePartTarget } from "./NativePartTarget";
import type { SvgBox } from "./svg-coords";
import { NativeOutlinePanel } from "./NativeOutlinePanel";
import { newChatDraftKey, useUiStore } from "../stores/ui";

type Selection = { part: PcbPartPosition; sourceSha256: string };

/** Real reference selection and guarded native edits; the surrounding marker is a drawing location. */
export function NativePartTools({ projectId, point, openAbove, onMoved, canPosition, box, onMutationBusyChange, visible = true }: { visible?: boolean; onMutationBusyChange: (busy: boolean) => void; box: SvgBox; canPosition: boolean; projectId: string; point: { x: number; y: number }; openAbove: boolean; onMoved: (point: { x: number; y: number }) => void }) {
  const client = useCoreClient(), preview = useRunTool();
  const popup = useRef<HTMLElement>(null);
  const outlineTrigger = useRef<HTMLButtonElement>(null);
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({ visibility: "hidden" });
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const latestPoint = useRef(point); latestPoint.current = point;
  const inFlight = useRef(false), mounted = useRef(true), appliedPoint = useRef<{ x: number; y: number } | null>(null);
  const [mode, setMode] = useState<"parts" | "outline">("parts");
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [fields, setFields] = useState({ x: "", y: "", rotation: "" });
  const [error, setError] = useState<string | null>(null), [message, setMessage] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const parts = usePcbPartsNear(projectId, point, open && mode === "parts");
  const current = parts.data;
  const sourceChanged = !!selection && !!current && selection.sourceSha256 !== current.sourceSha256;
  const values = parsePartPositionInput(fields);
  const changed = !!selection && !!values && (values.x !== selection.part.x || values.y !== selection.part.y || values.rotation !== ((selection.part.rotation % 360) + 360) % 360);
  const choose = (part: PcbPartPosition, sourceSha256: string) => {
    setSelection({ part, sourceSha256 }); setFields({ x: String(part.x), y: String(part.y), rotation: String(part.rotation) }); setError(null); setMessage(null); setPreviewError(null);
  };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const wasApplied = appliedPoint.current?.x === point.x && appliedPoint.current.y === point.y;
    appliedPoint.current = null;
    if (wasApplied) return;
    setSelection(null); setError(null); setMessage(null); setPreviewError(null);
  }, [projectId, point.x, point.y]);
  useEffect(() => {
    if (current?.parts.length === 1 && !selection && !inFlight.current) choose(current.parts[0]!, current.sourceSha256);
  }, [current, selection]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target) && !popup.current?.contains(event.target) && !(event.target instanceof Element && event.target.closest("[data-native-part-target]")) && !inFlight.current) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = root.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(390, window.innerWidth * .75), below = window.innerHeight - rect.bottom - 24, above = rect.top - 24;
      const anchor = root.current?.closest(".fd-location-anchor")?.getBoundingClientRect();
      if (mode === "outline") {
        const drawing = root.current?.closest(".fd-svg-host")?.getBoundingClientRect();
        if (drawing) {
          const left = drawing.left >= width + 36 ? drawing.left - width - 24 : window.innerWidth - drawing.right >= width + 36 ? drawing.right + 24 : 12;
          const height = Math.min(470, window.innerHeight - 24, (popup.current?.scrollHeight ?? 468) + 2);
          setPopupStyle({ left, width, top: Math.max(12, Math.min(drawing.top + 30, window.innerHeight - height - 12)), maxHeight: Math.min(470, window.innerHeight - 24) });
          return;
        }
      }
      if (anchor && (window.innerWidth - anchor.left >= width + 40 || anchor.left >= width + 40)) {
        const left = window.innerWidth - anchor.left >= width + 40 ? anchor.left + 40 : anchor.left - width - 40;
        const height = Math.min(470, window.innerHeight - 24, (popup.current?.scrollHeight ?? 468) + 2);
        setPopupStyle({ left, width, top: Math.max(12, Math.min(anchor.top + 20, window.innerHeight - height - 12)), maxHeight: Math.min(470, window.innerHeight - 24) });
        return;
      }
      const useAbove = below < 470 && above > below || above >= 470 && openAbove;
      setPopupStyle({ left: Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)), width, top: useAbove ? undefined : rect.bottom + 12, bottom: useAbove ? window.innerHeight - rect.top + 12 : undefined, maxHeight: Math.max(100, Math.min(470, useAbove ? above : below)) });
    };
    position();
    const observer = new ResizeObserver(position);
    if (popup.current) observer.observe(popup.current);
    window.addEventListener("resize", position); window.addEventListener("scroll", position, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); window.removeEventListener("scroll", position, true); };
  }, [open, openAbove, point.x, point.y, mode]);
  const close = () => { if (inFlight.current) return; setOpen(false); requestAnimationFrame(() => (mode === "outline" ? outlineTrigger.current : trigger.current)?.focus()); };
  const reload = async () => {
    if (!selection || inFlight.current) return;
    const origin = { ...point };
    setBusy(true); setError(null);
    try {
      const result = await inspectPcbParts(client, projectId, { reference: selection.part.ref });
      const part = result.parts.find((p) => p.ref === selection.part.ref);
      if (!part) throw new Error("This part is no longer in the saved PCB.");
      if (mounted.current && latestPoint.current.x === origin.x && latestPoint.current.y === origin.y) {
        choose(part, result.sourceSha256);
        if (useUiStore.getState().activeProjectId === projectId) { appliedPoint.current = { x: part.x, y: part.y }; onMoved(appliedPoint.current); }
      }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : "Could not reload this part."); }
    finally { if (mounted.current) setBusy(false); }
  };
  const apply = async () => {
    if (!selection || !values || !changed || selection.part.locked || sourceChanged || !canPosition || parts.isFetching || parts.isError || inFlight.current) return;
    const origin = { ...point };
    inFlight.current = true; onMutationBusyChange(true); setBusy(true); setError(null); setMessage(null); setPreviewError(null);
    let saved = false;
    try {
      const result = await client.callTool("pcb_place", { projectId, placements: [{ reference: selection.part.ref, position: { x: values.x, y: values.y }, rotation: values.rotation }], staleCopper: "keep", expectedSourceSha256: selection.sourceSha256 });
      const data = pcbToolJson(result);
      if (data.saved !== true) throw new Error("The backend did not confirm a saved placement. Reload the part before retrying.");
      saved = true;
      const warnings = pcbPlacementWarnings(result);
      const rendered = await preview.run("render_pcb_svg", { projectId });
      const inspected = await inspectPcbParts(client, projectId, { reference: selection.part.ref });
      const part = inspected.parts.find((p) => p.ref === selection.part.ref);
      if (!part) throw new Error("The saved part could not be found in the refreshed inspection.");
      if (mounted.current) {
        const sameLocation = latestPoint.current.x === origin.x && latestPoint.current.y === origin.y;
        if (sameLocation) choose(part, inspected.sourceSha256);
        const notice = warnings.affectedCopper || warnings.possibleShorts
          ? `${part.ref} saved. Placement analysis flagged ${warnings.affectedCopper} affected copper item(s)${warnings.possibleShorts ? ` and ${warnings.possibleShorts} possible short(s)` : ""}. Review routing and checks.`
          : `${part.ref} position saved. Run checks after changing placement.`;
        setMessage(rendered.status === "failed" ? `${notice} The preview could not update and remains out of date.` : notice);
        setPreviewError(rendered.status === "failed" ? rendered.error ?? "The exporter returned no error detail." : null);
        if (sameLocation && useUiStore.getState().activeProjectId === projectId) { appliedPoint.current = { x: part.x, y: part.y }; onMoved(appliedPoint.current); }
      }
    } catch (failure) {
      if (mounted.current) setError(`${saved ? "The position was saved, but refresh could not finish." : "Could not apply this placement."} Reload the part before retrying. ${failure instanceof Error ? failure.message : ""}`);
    } finally { inFlight.current = false; onMutationBusyChange(false); if (mounted.current) setBusy(false); }
  };
  const drawingHost = root.current?.closest<HTMLElement>(".fd-svg-host");
  return <div className="fd-native-part-control" data-mode={mode} data-open={open} ref={root} onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); }
    if (event.key === "Escape" && open) { event.stopPropagation(); close(); }
  }}>
    <Button ref={trigger} size="sm" variant="ghost" aria-expanded={open && mode === "parts"} disabled={busy || !canPosition && !open} title={canPosition ? "Inspect and position native PCB parts" : "Update this preview to verify its native PCB coordinates before positioning parts"} onClick={() => { setMode("parts"); setOpen(mode !== "parts" || !open); }}><Icon name="pcb" width={15} height={15} />{selection?.part.ref ?? "Parts"}<Icon name="chevronDown" width={12} height={12} /></Button>
    <Button ref={outlineTrigger} size="sm" variant="ghost" aria-expanded={open && mode === "outline"} disabled={busy || !canPosition && !open} onClick={() => { setMode("outline"); setOpen(mode !== "outline" || !open); }}>Board size</Button>
    {visible && open && mode === "parts" && drawingHost && selection && values && canPosition && !sourceChanged && !busy && !parts.isError && !selection.part.locked && <NativePartTarget host={drawingHost} box={box} point={values} reference={selection.part.ref} changed={changed} onMove={target => { setFields(previous => ({ ...previous, x: String(target.x), y: String(target.y) })); setError(null); setMessage(null); setPreviewError(null); }} />}
    {open && createPortal(<section ref={popup} style={{ ...popupStyle, ...(!visible ? { visibility: "hidden" as const } : {}) }} data-canvas-tools className="fd-native-part-popover" role="dialog" aria-label={mode === "parts" ? "PCB part position" : "Board size"} aria-busy={busy}>
      <header><strong>{mode === "outline" ? "Board size" : selection ? `${selection.part.ref} · ${selection.part.value}` : "Parts near this location"}</strong><IconButton title="Close board tools" size="sm" disabled={busy} onClick={close}><Icon name="close" width={14} height={14} /></IconButton></header>
      {mode === "outline" ? <NativeOutlinePanel visible={visible} onMutationBusyChange={onMutationBusyChange} host={drawingHost ?? null} box={box} projectId={projectId} canPosition={canPosition} onBusyChange={value => { inFlight.current = value; if (mounted.current) setBusy(value); }} /> : <>
      {parts.isPending && !current ? <div className="flex items-center gap-2 text-muted"><Spinner />Inspecting saved PCB…</div> : parts.isError && !current ? <p role="alert">Could not inspect parts. <Button size="sm" onClick={() => void parts.refetch()}>Retry</Button></p> : current && <>
        {current.parts.length > 0 ? <label>Part<select aria-label="Select native PCB part" value={selection?.part.ref ?? ""} disabled={busy} onChange={(event) => { const part = current.parts.find((p) => p.ref === event.target.value); if (part) choose(part, current.sourceSha256); }}><option value="">Choose a part</option>{[...current.parts].sort((a, b) => Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y)).map((part) => <option key={part.ref} value={part.ref}>{part.ref} · {part.value}</option>)}</select></label> : <p>No part origins within 5 mm. Select a location nearer the part you want to move.</p>}
        {current.truncated && <p>More parts are nearby. Select a more precise location.</p>}
      </>}
      {parts.isError && current && <p role="alert" className="fd-native-part-warning">The latest part inspection failed. <Button size="sm" disabled={busy} onClick={() => void parts.refetch()}>Retry inspection</Button></p>}
      {!canPosition && !busy && <p className="fd-native-part-warning">Verify or update the PCB preview before applying part positions.</p>}
      {selection && <>
        <p className="fd-native-part-footprint">{selection.part.footprint || "Embedded footprint"} · {selection.part.flipped ? "Bottom" : "Top"}</p>
        {sourceChanged && <p role="status" className="fd-native-part-warning">The PCB changed. Reload this part before applying edits.</p>}
        {selection.part.locked && <p className="fd-native-part-warning">This part or its group is locked. Unlock it in KiCad before positioning it here.</p>}
        <form onSubmit={(event) => { event.preventDefault(); void apply(); }}>
          <div className="fd-native-part-fields">{([['x', 'X (mm)'], ['y', 'Y (mm)'], ['rotation', 'Rotation (°)']] as const).map(([key, label]) => <label key={key}>{label}<Input type="number" step="any" aria-label={label} value={fields[key]} disabled={busy || selection.part.locked} onChange={(event) => { const value = event.currentTarget.value; setFields((previous) => ({ ...previous, [key]: value })); }} /></label>)}</div>
          <div className="fd-native-part-actions"><Button size="sm" disabled={busy || selection.part.locked} onClick={() => setFields((previous) => ({ ...previous, rotation: String((Number(previous.rotation) || 0) + 90) }))}>+90°</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => void reload()}>Reload part</Button><Button size="sm" variant="primary" type="submit" disabled={busy || !canPosition || parts.isFetching || parts.isError || !values || !changed || sourceChanged || selection.part.locked}>{busy ? "Saving / refreshing…" : "Apply position"}</Button></div>
        </form>
        <Button size="sm" variant="ghost" disabled={busy || sourceChanged || !canPosition} onClick={() => {
          const ui = useUiStore.getState();
          if (ui.activeProjectId !== projectId) return;
          const key = ui.activeThreadId ?? newChatDraftKey(projectId);
          const prompt = `Explain part ${JSON.stringify(selection.part.ref)} in this PCB. Inspect the latest saved board for its connections and purpose.`;
          const previous = ui.drafts[key] ?? "";
          ui.setDraft(key, previous.trim() ? `${previous}\n\n${prompt}` : prompt);
          setOpen(false); ui.focusComposer();
        }}>Ask about {selection.part.ref}</Button>
        <p className="fd-native-part-note">Drag the labeled target or use arrow keys to preview a position; Apply saves it. Coordinates use KiCad’s board origin. Existing routed copper is kept; inspect routing and run checks afterward.</p>
      </>}
      {message && <p role="status" className="fd-native-part-warning">{message}<Button size="sm" variant="ghost" onClick={() => useUiStore.getState().setBoardTab("drc")}>Open checks</Button></p>}
      {previewError && <details className="fd-native-part-note"><summary>Why couldn’t the preview update?</summary><p>{previewError}</p><p>Resolve the export error, then choose Update preview. The native placement is already saved.</p></details>}
      {error && <p role="alert" className="fd-native-part-warning">{error}</p>}
      </>}
    </section>, root.current?.closest(".fd-canvas-workspace") ?? document.body)}
  </div>;
}
