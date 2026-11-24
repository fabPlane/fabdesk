import { prepareComMarkerArtwork, useCore, useRunTool } from "@fabdesk/client-core";
import type { BoardSourceSelection } from "@fabdesk/protocol";
import { useEffect, useRef, useState } from "react";
import { Button, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { ComMarkerMaterialPreset } from "./ComMarkerMaterialPreset";

type Artwork = Awaited<ReturnType<typeof prepareComMarkerArtwork>>;
type Handoff = { path: string; opened: boolean; copied: boolean };
type Job = "board" | "coupon";

function dimensions(width: number, height: number) {
  return `${Number(width.toFixed(3))} × ${Number(height.toFixed(3))} mm`;
}

async function testCoupon(): Promise<Artwork> {
  const { default: svg } = await import("../../../../docs/examples/omni-x-copper-coupon-remove.svg?raw");
  return { svg: new Blob([svg], { type: "image/svg+xml" }), filename: "FabDesk-coupon-20x12.svg",
    widthMm: 20, heightMm: 12, artworkBounds: { xMm: 0, yMm: 0, widthMm: 20, heightMm: 12 } };
}

export function ComMarkerStudioExport({ projectId, prefix, board, disabled, sourceNote, onBusy, onSaved }: {
  projectId: string; prefix: string; board?: BoardSourceSelection; disabled: boolean; sourceNote: string;
  onBusy: (busy: boolean) => void; onSaved: () => void;
}) {
  const { client, host } = useCore(), { run } = useRunTool();
  const [busy, setBusy] = useState(false), working = useRef(false);
  const [job, setJob] = useState<Job>("board");
  const [pathCopy, setPathCopy] = useState("");
  const lens = useUiStore(s => s.commarkerStock.lens);
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

  async function prepare(next: Job) {
    if (working.current || (next === "board" && disabled)) return;
    const current = () => mounted.current && useUiStore.getState().activeProjectId === projectId;
    working.current = true;
    setBusy(true); onBusy(true); setJob(next); setError(null); setHandoff(null); setArtwork(null); setPathCopy("");
    try {
      const prepared = next === "coupon" ? await testCoupon() :
        await prepareComMarkerArtwork({ client, projectId, prefix, ...(board ? { board } : {}), run });
      if (!current()) return;
      setArtwork(prepared);
      if (next === "board") onSaved();
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
  async function copyPath(path: string) {
    try {
      if (host.copyText) await host.copyText(path);
      else await navigator.clipboard.writeText(path);
      setPathCopy("SVG path copied.");
    } catch { setPathCopy("Select and copy the path below."); }
  }
  const bounds = artwork?.artworkBounds;
  return <section className="mt-4 space-y-3 rounded-lg border border-border bg-bg/40 p-4" aria-label="ComMarker Studio copper export">
    <div><h3 className="text-[13px] font-semibold">Front copper removal</h3>
      <p className="mt-1 text-xs leading-5 text-muted">Full-size SVG for single-sided copper-clad stock. Import via <strong>Vector</strong> and enable <strong>Fill</strong> for the areas to clear.</p></div>
    <ComMarkerMaterialPreset disabled={busy} desktop={!!host.openInComMarkerStudio} onCoupon={() => void prepare("coupon")} />
    {artwork && previewUrl && <figure className="space-y-2">
      <div className="flex h-36 items-center justify-center rounded border border-border bg-white p-3"><img src={previewUrl} alt="Copper-removal artwork. Black regions are engraved." className="h-full w-full object-contain" /></div>
      <figcaption className="space-y-1 text-xs leading-5 text-muted">
        <p><strong>{job === "coupon" ? "Test coupon" : "Board"} · {dimensions(artwork.widthMm, artwork.heightMm)}</strong>. Black areas remove copper.</p>
        {bounds && <p>In Studio, select the whole graphic. Its size should read <strong>{dimensions(bounds.widthMm, bounds.heightMm)}</strong>.
          {(bounds.xMm > 0 || bounds.yMm > 0) && <> The graphic starts {Number(bounds.xMm.toFixed(3))} mm from the left and {Number(bounds.yMm.toFixed(3))} mm from the top of the board.</>}</p>}
        {bounds && lens && (bounds.widthMm > Number(lens) || bounds.heightMm > Number(lens)) &&
          <p role="status" className="text-fg">The artwork extends beyond the {lens} × {lens} mm field in this orientation. Check placement at 1:1 before marking.</p>}
        {job === "coupon" && <p>With Fill enabled, both traces and all four round pads should remain clear.</p>}
      </figcaption>
    </figure>}
    {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    {handoff && <div role="status" className="space-y-1 text-xs leading-5">
      <p>{handoff.opened ? "Studio opened." : "SVG saved locally."} {handoff.copied
        ? host.platform === "darwin" ? "Choose Vector, press ⌘⇧G, paste the SVG path and press Return." : "Choose Vector and paste the SVG path into File name."
        : "In Studio, choose Vector and select the SVG below."}</p>
      <Button size="sm" variant="secondary" onClick={() => void copyPath(handoff.path)}>Copy SVG path</Button>
      {pathCopy && <p>{pathCopy}</p>}
      <p className="select-all break-all font-mono text-muted">{handoff.path}</p></div>}
    {!host.openInComMarkerStudio && artwork && !error && <p role="status" className="text-xs">SVG ready. Choose Vector in ComMarker Studio to import your download.</p>}
    {disabled && !busy && <p role="status" className="text-xs text-muted">{sourceNote}</p>}
    <div className="flex justify-end"><Button size="sm" variant="primary" onClick={() => void prepare("board")} disabled={disabled || busy}>
      {busy ? <><Spinner /> Preparing artwork…</> : host.openInComMarkerStudio ? "Open in ComMarker Studio" : "Download copper SVG"}
    </Button></div>
  </section>;
}
