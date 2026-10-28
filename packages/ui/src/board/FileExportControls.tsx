import { useEffect, useState } from "react";
import { Button, Select, Spinner } from "../components/ui";
import { FileGlyph } from "./FileGlyph";
import { cn } from "../util";
import { FILE_EXPORTS as EXPORTS, SECONDARY_FILE_EXPORTS, type FileExportKind as ExportKind } from "./file-exports";
import { STENCIL_THICKNESSES_MM, DEFAULT_STENCIL_THICKNESS_MM } from "../stores/stencil-thickness";
import { LaserStencilPresetPanel, type LaserStencilFormState } from "./LaserStencilPresetPanel";

/** The existing file exporters share the same deliberate controls in Files and Outputs. */
export function FileExportControls({ exportChoices, exportKind, setExportKind, thicknessMm, onThickness, laserForm, setLaserForm, busy, canExport, sourceNote, error, onExport, onClose }: {
  exportChoices: readonly ExportKind[]; exportKind: ExportKind; setExportKind: (kind: ExportKind) => void;
  thicknessMm: number; onThickness: (value: number) => void;
  laserForm: LaserStencilFormState; setLaserForm: (form: LaserStencilFormState) => void;
  busy: boolean; canExport: boolean; sourceNote: string; error?: string;
  onExport: () => void; onClose?: () => void;
}) {
  const common = exportChoices.filter(kind => !SECONDARY_FILE_EXPORTS.includes(kind));
  const other = exportChoices.filter(kind => SECONDARY_FILE_EXPORTS.includes(kind));
  const [moreOpen, setMoreOpen] = useState(SECONDARY_FILE_EXPORTS.includes(exportKind));
  useEffect(() => { if (SECONDARY_FILE_EXPORTS.includes(exportKind)) setMoreOpen(true); }, [exportKind]);
  const choices = (kinds: readonly ExportKind[]) => kinds.map(kind => <label key={kind} className={cn("flex cursor-pointer items-center gap-3 rounded-lg border p-3", exportKind === kind ? "border-accent bg-accent/10" : "border-border hover:bg-panel-2/50")}>
    <input type="radio" name="project-export" value={kind} checked={exportKind === kind} onChange={() => setExportKind(kind)} className="accent-[var(--fd-accent)]" />
    <FileGlyph kind={EXPORTS[kind].kind} />
    <span><span className="block text-[13px] font-medium">{EXPORTS[kind].title}</span><span className="block text-xs text-muted">{EXPORTS[kind].detail}</span></span>
  </label>);
  return <div className="fd-export-controls">
        <fieldset disabled={busy}>
          <legend className="mb-3 text-xs text-muted">What would you like to make?</legend>
          <div className="space-y-2">
            {choices(common)}
          </div>
          {other.length > 0 && <details className="fd-export-other-formats mt-4" open={moreOpen} onToggle={event => setMoreOpen(event.currentTarget.open)}>
            <summary className="cursor-pointer text-xs text-muted">More formats{SECONDARY_FILE_EXPORTS.includes(exportKind) ? ` · ${EXPORTS[exportKind].title}` : ""}</summary>
            <div className="mt-3 space-y-2">{choices(other)}</div>
          </details>}
          {exportKind === "export_stencil" && <div className="mt-4 rounded-lg border border-border bg-bg/40 p-3">
            <label className="flex items-center justify-between gap-3 text-xs font-medium">Stencil thickness
              <Select aria-label="Stencil thickness" value={thicknessMm} onChange={(e) => onThickness(Number(e.target.value))}>
                {STENCIL_THICKNESSES_MM.map((mm) => <option key={mm} value={mm}>{mm.toFixed(2)} mm{mm === DEFAULT_STENCIL_THICKNESS_MM ? " (default)" : ""}</option>)}
              </Select>
            </label>
            <p className="mt-2 text-xs leading-5 text-muted">Total stencil thickness. Match this to the total printed layer thickness in your slicer. Thicker stencils hold more paste.</p>
          </div>}
          {exportKind === "export_laser_stencil" && <LaserStencilPresetPanel form={laserForm} onChange={setLaserForm} />}
        </fieldset>
        {error && <p role="alert" className="mt-3 break-words text-xs text-danger">{error}</p>}
        <div className="mt-5 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
          <p className="fd-export-source-note w-full text-xs text-muted" role="status">{sourceNote}</p>
          <span className="mr-auto text-[11px] text-muted">Saved under exports/</span>
          {onClose && <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>}
          <Button size="sm" variant="primary" disabled={busy || !canExport} onClick={onExport}>{busy ? <><Spinner /> Exporting…</> : EXPORTS[exportKind].action}</Button>
        </div>
  </div>;
}
