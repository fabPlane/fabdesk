import { prepareComMarkerArtwork, useCore, useRunTool } from "@fabdesk/client-core";
import type { BoardSourceSelection } from "@fabdesk/protocol";
import { useEffect, useRef, useState } from "react";
import { Button, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { ComMarkerMaterialPreset } from "./ComMarkerMaterialPreset";

type Artwork = Awaited<ReturnType<typeof prepareComMarkerArtwork>>;
type Handoff = { path: string; opened: boolean; copied: boolean };

export function ComMarkerStudioExport({ projectId, prefix, board, disabled, sourceNote, onBusy, onSaved }: {
  projectId: string; prefix: string; board?: BoardSourceSelection; disabled: boolean; sourceNote: string;
  onBusy: (busy: boolean) => void; onSaved: () => void;
}) {
  const { client, host } = useCore(), { run } = useRunTool();
  const [busy, setBusy] = useState(false), working = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [artwork, setArtwork] = useState<Artwork | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; onBusy(false); };
  }, [onBusy]);
  useEffect(() => {
    if (!artwork) { setPreviewUrl(null); return; }
    const url = URL.createObjectURL(artwork.svg.slice(0, artwork.svg.size, "image/svg+xml"));
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [artwork]);

  async function prepare() {
    if (working.current || disabled) return;
    const current = () => mounted.current && useUiStore.getState().activeProjectId === projectId;
    working.current = true;
    setBusy(true); onBusy(true); setError(null); setHandoff(null); setArtwork(null);
    try {
      const prepared = await prepareComMarkerArtwork({ client, projectId, prefix, ...(board ? { board } : {}), run });
      if (!current()) return;
      setArtwork(prepared);
      onSaved();
      if (host.openInComMarkerStudio) {
        const bytes = new Uint8Array(await prepared.svg.arrayBuffer());
        if (!current()) return;
        const result = await host.openInComMarkerStudio(prepared.filename, bytes);
        if (current()) setHandoff(result);
      } else {
        const url = URL.createObjectURL(prepared.svg), link = document.createElement("a");
        link.href = url; link.download = prepared.filename; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }
    } catch (failure) {
      if (current()) setError(failure instanceof Error ? failure.message : "Could not prepare the Studio artwork.");
    } finally {
      working.current = false;
      if (mounted.current) { setBusy(false); onBusy(false); }
    }
  }
  return <section className="mt-4 space-y-3 rounded-lg border border-border bg-bg/40 p-4" aria-label="ComMarker Studio copper export">
    <div><h3 className="text-[13px] font-semibold">Front copper removal</h3>
      <p className="mt-1 text-xs leading-5 text-muted">Full-size SVG for single-sided copper-clad stock. Import via <strong>Vector</strong> and enable <strong>Fill</strong> for the areas to clear.</p></div>
    <ComMarkerMaterialPreset disabled={busy} />
    {artwork && previewUrl && <figure className="space-y-2">
      <div className="flex h-36 items-center justify-center rounded border border-border bg-white p-3"><img src={previewUrl} alt="Copper-removal artwork. Black regions are engraved." className="h-full w-full object-contain" /></div>
      <figcaption className="text-xs text-muted"><strong>{Number(artwork.widthMm.toFixed(3))} × {Number(artwork.heightMm.toFixed(3))} mm</strong> · Black areas remove copper.</figcaption>
    </figure>}
    {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    {handoff && <div role="status" className="space-y-1 text-xs leading-5">
      <p>{handoff.opened ? "Studio opened." : "SVG saved locally."} {handoff.copied
        ? host.platform === "darwin" ? "Choose Vector, press ⌘⇧G, paste the SVG path and press Return." : "Choose Vector and paste the SVG path into File name."
        : "In Studio, choose Vector and select the SVG below."}</p>
      <p className="break-all font-mono text-muted">{handoff.path}</p></div>}
    {!host.openInComMarkerStudio && artwork && !error && <p role="status" className="text-xs">SVG ready. Choose Vector in ComMarker Studio to import your download.</p>}
    {disabled && !busy && <p role="status" className="text-xs text-muted">{sourceNote}</p>}
    <div className="flex justify-end"><Button size="sm" variant="primary" onClick={() => void prepare()} disabled={disabled || busy}>
      {busy ? <><Spinner /> Preparing artwork…</> : host.openInComMarkerStudio ? "Open in ComMarker Studio" : "Download copper SVG"}
    </Button></div>
  </section>;
}
