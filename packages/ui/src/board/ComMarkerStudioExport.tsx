import { makeStudioCopperProject, prepareComMarkerArtwork, useCore, useRunTool } from "@fabdesk/client-core";
import type { BoardSourceSelection } from "@fabdesk/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { ComMarkerMaterialPreset } from "./ComMarkerMaterialPreset";
import { useStudioTemplate } from "./useStudioTemplate";

type Artwork = Awaited<ReturnType<typeof prepareComMarkerArtwork>>;
type Handoff = { path: string; opened: boolean; copied: boolean };
type Job = "board" | "coupon";

function dimensions(width: number, height: number) {
  return `${Number(width.toFixed(3))} × ${Number(height.toFixed(3))} mm`;
}

function outsideField(artwork: Artwork, fieldMm: number, centered: boolean) {
  const bounds = artwork.artworkBounds;
  if (!bounds) return false;
  if (!centered) return bounds.widthMm > fieldMm || bounds.heightMm > fieldMm;
  // Native projects put the physical board center at (0, 0), even for off-center artwork.
  const x = bounds.xMm - artwork.widthMm / 2, y = bounds.yMm - artwork.heightMm / 2;
  const halfField = fieldMm / 2 + 1e-9;
  return x < -halfField || x + bounds.widthMm > halfField ||
    y < -halfField || y + bounds.heightMm > halfField;
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
  const [projectFile, setProjectFile] = useState(false);
  const [pathCopy, setPathCopy] = useState("");
  const { lens, foilUm } = useUiStore(s => s.commarkerStock);
  const template = useStudioTemplate(lens, foilUm);
  const [error, setError] = useState<string | null>(null);
  const [artwork, setArtwork] = useState<Artwork | null>(null);
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const mounted = useRef(false);
  const settingsRevision = useRef(0);
  useLayoutEffect(() => {
    settingsRevision.current++;
    setArtwork(null); setHandoff(null); setPathCopy(""); setError(null);
  }, [lens, foilUm, template.file?.sha256]);
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

  async function prepare(next: Job, svgOnly = false) {
    if (working.current || template.loading || template.change.isPending || (next === "board" && disabled)) return;
    const useTemplate = svgOnly ? null : template.file;
    const revision = settingsRevision.current;
    const current = () => mounted.current && settingsRevision.current === revision && useUiStore.getState().activeProjectId === projectId;
    working.current = true;
    setBusy(true); onBusy(true); setJob(next); setProjectFile(!!useTemplate); setError(null); setHandoff(null); setArtwork(null); setPathCopy("");
    try {
      const prepared = next === "coupon" ? await testCoupon() :
        await prepareComMarkerArtwork({ client, projectId, prefix, ...(board ? { board } : {}), run });
      if (!current()) return;
      setArtwork(prepared);
      if (next === "board") onSaved();
      let file = prepared.svg, filename = prepared.filename;
      if (useTemplate) {
        const bytes = makeStudioCopperProject(await prepared.svg.text(), useTemplate.bytes);
        file = new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" });
        filename = filename.replace(/\.svg$/, ".orzr");
      }
      if (!current()) return;
      if (host.openInComMarkerStudio) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (!current()) return;
        const result = await host.openInComMarkerStudio(filename, bytes);
        if (current()) setHandoff(result);
      } else {
        const url = URL.createObjectURL(file), link = document.createElement("a");
        link.href = url; link.download = filename; link.click();
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
    const revision = settingsRevision.current;
    let feedback: string;
    try {
      if (host.copyText) await host.copyText(path);
      else await navigator.clipboard.writeText(path);
      feedback = projectFile ? "Project path copied." : "SVG path copied.";
    } catch { feedback = "Select and copy the path below."; }
    if (mounted.current && settingsRevision.current === revision) setPathCopy(feedback);
  }
  const bounds = artwork?.artworkBounds;
  const blocked = disabled || busy || template.loading || template.change.isPending;
  const fileLabel = projectFile ? "Project" : "SVG";
  return <section className="mt-4 space-y-3 rounded-lg border border-border bg-bg/40 p-4" aria-label="ComMarker Studio copper export">
    <div><h3 className="text-[13px] font-semibold">Front copper removal</h3>
      <p className="mt-1 text-xs leading-5 text-muted">{template.file
        ? <>Open the native Studio project to review your board with the saved pen and Fill settings.</>
        : <>Full-size SVG for single-sided copper-clad stock. Import via <strong>Vector</strong> and enable <strong>Fill</strong> for the areas to clear.</>}</p></div>
    <ComMarkerMaterialPreset disabled={busy || template.loading} desktop={!!host.openInComMarkerStudio} template={template} onCoupon={() => void prepare("coupon")} />
    {artwork && previewUrl && <figure className="space-y-2">
      <div className="flex h-36 items-center justify-center rounded border border-border bg-white p-3"><img src={previewUrl} alt="Copper-removal artwork. Black regions are engraved." className="h-full w-full object-contain" /></div>
      <figcaption className="space-y-1 text-xs leading-5 text-muted">
        <p><strong>{job === "coupon" ? "Test coupon" : "Board"} · {dimensions(artwork.widthMm, artwork.heightMm)}</strong>. Black areas remove copper.</p>
        {projectFile && <p>The PCB center is at (0, 0) in Studio.</p>}
        {bounds && <p>In Studio, select the whole graphic. Its size should read <strong>{dimensions(bounds.widthMm, bounds.heightMm)}</strong>.
          {(bounds.xMm > 0 || bounds.yMm > 0) && <> The graphic starts {Number(bounds.xMm.toFixed(3))} mm from the left and {Number(bounds.yMm.toFixed(3))} mm from the top of the board.</>}</p>}
        {lens && outsideField(artwork, Number(lens), projectFile) &&
          <p role="status" className="text-fg">The artwork extends beyond the {lens} × {lens} mm field {projectFile ? "at this position" : "in this orientation"}. Check placement at 1:1 before marking.</p>}
        {job === "coupon" && <p>With Fill enabled, both traces and all four round pads should remain clear.</p>}
      </figcaption>
    </figure>}
    {error && <p role="alert" className="break-words text-xs text-danger">{error}</p>}
    {handoff && <div role="status" className="space-y-1 text-xs leading-5">
      <p>{handoff.opened ? "Studio opened." : `${fileLabel} saved locally.`} Choose <strong>{projectFile ? "Open" : "Vector"}</strong> in Studio.
        {handoff.copied
          ? host.platform === "darwin" ? " Press ⌘⇧G, paste the path and press Return." : " Paste the path into File name."
          : " Select the file below."}</p>
      {projectFile && <p>Check graphic placement and material settings in Studio before marking.</p>}
      <Button size="sm" variant="secondary" onClick={() => void copyPath(handoff.path)}>Copy {projectFile ? "project" : "SVG"} path</Button>
      {pathCopy && <p>{pathCopy}</p>}
      <p className="select-all break-all font-mono text-muted">{handoff.path}</p></div>}
    {!host.openInComMarkerStudio && artwork && !error && !busy && <p role="status" className="text-xs">{projectFile
      ? "Studio project downloaded. Choose Open in Studio and review placement and material settings."
      : "SVG ready. Choose Vector in ComMarker Studio to import your download."}</p>}
    {disabled && !busy && <p role="status" className="text-xs text-muted">{sourceNote}</p>}
    <div className="flex flex-wrap justify-end gap-2">
      {template.file && <Button size="sm" variant="ghost" disabled={blocked} onClick={() => void prepare("board", true)}>Use SVG instead</Button>}
      <Button size="sm" variant="primary" onClick={() => void prepare("board")} disabled={blocked}>
      {busy ? <><Spinner /> Preparing artwork…</> : host.openInComMarkerStudio ? "Open in ComMarker Studio" : template.file ? "Download Studio project" : "Download copper SVG"}
    </Button></div>
  </section>;
}
