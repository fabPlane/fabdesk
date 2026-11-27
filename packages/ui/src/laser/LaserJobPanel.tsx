/**
 * fabPlane's own laser job editor (USB / Wi-Fi driver): open a drawing (SVG / DXF) or use a board side,
 * see it on the lens field, place it, and set power, speed and fill. One `laser_cell` call per change.
 *
 * Deliberately small: a preview you can click to place the job, a material preset, and the handful of
 * settings that matter. Everything else stays in Settings.
 */
import { useEffect, useMemo, useState } from "react";
import {
  formatDuration,
  useLaserCellAction,
  useLaserJob,
  type LaserEdgeSettings,
  type LaserJobSettings,
  type LaserJobView,
} from "@fabdesk/client-core";
import { Button, Input, Select, Spinner } from "../components/ui";

type Vec = [number, number];

const ringPath = (rings: Vec[][], close: boolean) =>
  rings.map(r => `M${r.map(([x, y]) => `${x},${y}`).join("L")}${close ? "Z" : ""}`).join("");

/** The lens field (mm, centre 0,0, Y up) with the job drawn where it will be marked. Click to move the job there. */
function FieldPreview({ job, onPlace, disabled }: { job: LaserJobView; onPlace: (x: number, y: number) => void; disabled: boolean }) {
  const half = job.fieldMm / 2;
  const { width, height } = job.boardMm;
  const left = job.positionMm.x - width / 2, bottom = job.positionMm.y - height / 2;
  const grid = useMemo(() => {
    const out: number[] = [];
    for (let v = -half + 10; v < half; v += 10) out.push(v);
    return out;
  }, [half]);
  const fills = useMemo(() => ringPath(job.preview.fills, true), [job.preview.fills]);
  const lines = useMemo(() => ringPath(job.preview.lines, false), [job.preview.lines]);
  const place = (e: React.MouseEvent<SVGSVGElement>) => {
    if (disabled) return;
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * job.fieldMm - half;
    const y = half - ((e.clientY - box.top) / box.height) * job.fieldMm;
    onPlace(Math.round(x * 10) / 10, Math.round(y * 10) / 10);
  };
  return <svg className="fd-lc-field-preview" viewBox={`${-half} ${-half} ${job.fieldMm} ${job.fieldMm}`} onClick={place} role="img" aria-label={`Lens field ${job.fieldMm} mm with the job at X ${job.positionMm.x}, Y ${job.positionMm.y}`} data-disabled={disabled || undefined}>
    <g transform="scale(1,-1)">
      <rect x={-half} y={-half} width={job.fieldMm} height={job.fieldMm} className="fd-lc-fp-field" />
      {grid.map(v => <g key={v}><line x1={v} y1={-half} x2={v} y2={half} className="fd-lc-fp-grid" /><line x1={-half} y1={v} x2={half} y2={v} className="fd-lc-fp-grid" /></g>)}
      <line x1={-3} y1={0} x2={3} y2={0} className="fd-lc-fp-centre" /><line x1={0} y1={-3} x2={0} y2={3} className="fd-lc-fp-centre" />
      <g transform={`translate(${left},${bottom})`}>
        <rect x={0} y={0} width={width} height={height} className="fd-lc-fp-frame" />
        {fills && <path d={fills} className="fd-lc-fp-fill" fillRule="evenodd" />}
        {lines && <path d={lines} className="fd-lc-fp-line" />}
      </g>
    </g>
  </svg>;
}

const num = (v: string, fallback: number) => (v.trim() === "" || !Number.isFinite(Number(v)) ? fallback : Number(v));

/** Preview, placement and settings of the current job; `busy` locks it while the laser runs. */
export function LaserJobPanel({ busy: cellBusy }: { busy: boolean }) {
  const act = useLaserCellAction();
  const view = useLaserJob(true);
  const job = view.data?.job ?? null;
  const presets = view.data?.presets ?? [];
  const [s, setS] = useState<LaserJobSettings | null>(null);
  const [edge, setEdge] = useState<LaserEdgeSettings | null>(null);
  const [pos, setPos] = useState({ x: "0", y: "0" });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!job) return;
    setS(job.settings);
    setEdge(job.edge);
    setPos({ x: String(job.positionMm.x), y: String(job.positionMm.y) });
  }, [job]);
  if (view.isPending) return <p className="fd-lc-note"><Spinner /> Reading the job…</p>;
  if (!job || !s) return view.data?.error ? <p className="fd-lc-warn">{view.data.error}</p> : null;

  const save = async (key: string, patch: Record<string, unknown>) => {
    setBusy(key);
    setError(null);
    try { await act({ action: "job_update", ...patch }); await view.refetch(); }
    catch (e) { setError(e instanceof Error ? e.message.replace(/^Error:\s*/, "") : String(e)); }
    finally { setBusy(null); }
  };
  const locked = cellBusy || !!busy;
  const dirty = JSON.stringify(s) !== JSON.stringify(job.settings) || JSON.stringify(edge) !== JSON.stringify(job.edge);
  const setNum = (key: keyof LaserJobSettings) => (e: React.ChangeEvent<HTMLInputElement>) => setS({ ...s, [key]: num(e.target.value, s[key]) });
  const applyPreset = (id: string) => {
    const p = presets.find(x => x.id === id);
    if (!p) return;
    setS(p.settings);
    setEdge(p.edge ?? null);
  };
  const place = (x: number, y: number) => void save("place", { positionMm: { x, y } });

  return <div className="fd-lc-job">
    <div className="fd-lc-job-grid">
      <div>
        <FieldPreview job={job} onPlace={place} disabled={locked} />
        <p className="fd-lc-note">{job.fieldMm} mm lens field, seen from above. Click to move the job there.</p>
      </div>
      <div className="fd-lc-job-side">
        <p className="fd-lc-note"><b>{job.name}</b>: {job.boardMm.width.toFixed(1)} × {job.boardMm.height.toFixed(1)} mm · about <b>{formatDuration(job.estimatedSeconds)}</b></p>
        <div className="fd-lc-row fd-lc-row-tight">
          <label className="fd-lc-field"><span>Centre X (mm)</span><Input type="number" step={0.1} value={pos.x} disabled={locked} onChange={e => setPos({ ...pos, x: e.target.value })} onBlur={() => place(num(pos.x, job.positionMm.x), num(pos.y, job.positionMm.y))} /></label>
          <label className="fd-lc-field"><span>Centre Y (mm)</span><Input type="number" step={0.1} value={pos.y} disabled={locked} onChange={e => setPos({ ...pos, y: e.target.value })} onBlur={() => place(num(pos.x, job.positionMm.x), num(pos.y, job.positionMm.y))} /></label>
        </div>
        <div className="fd-lc-actions">
          <Button size="sm" variant="ghost" disabled={locked} onClick={() => place(0, 0)}>Centre of lens</Button>
          {job.positionFromJob && <Button size="sm" variant="ghost" disabled={locked} title="Use the board centre from Settings (the jig)" onClick={() => void save("place", { positionMm: null })}>Jig position</Button>}
        </div>
        <label className="fd-lc-field"><span>Material (starting point; test on scrap first)</span>
          <Select value="" disabled={locked} onChange={e => applyPreset(e.target.value)}>
            <option value="">Choose a preset…</option>
            {presets.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          </Select>
        </label>
        <div className="fd-lc-row fd-lc-row-tight">
          <label className="fd-lc-field"><span>Power (%)</span><Input type="number" min={0} max={100} value={s.powerPct} disabled={locked} onChange={setNum("powerPct")} /></label>
          <label className="fd-lc-field"><span>Speed (mm/s)</span><Input type="number" min={1} max={20000} value={s.speedMmPerS} disabled={locked} onChange={setNum("speedMmPerS")} /></label>
          <label className="fd-lc-field"><span>Frequency (kHz)</span><Input type="number" min={1} max={1000} value={s.frequencyKhz} disabled={locked} onChange={setNum("frequencyKhz")} /></label>
          <label className="fd-lc-field"><span>Passes</span><Input type="number" min={1} max={200} step={1} value={s.passes} disabled={locked} onChange={setNum("passes")} /></label>
          <label className="fd-lc-field"><span>Fill spacing (mm, 0 = outline)</span><Input type="number" min={0} max={10} step={0.005} value={s.intervalMm} disabled={locked} onChange={setNum("intervalMm")} /></label>
          <label className="fd-lc-field"><span>Fill angle (°)</span><Input type="number" min={-360} max={360} value={s.angleDeg} disabled={locked} onChange={setNum("angleDeg")} /></label>
        </div>
        <label className="fd-lc-check"><input type="checkbox" checked={s.angleStepDeg === 90} disabled={locked} onChange={e => setS({ ...s, angleStepDeg: e.target.checked ? 90 : 0 })} /><span>Cross fill (both directions every pass)</span></label>
        <label className="fd-lc-check"><input type="checkbox" checked={!!edge && edge.passes > 0} disabled={locked} onChange={e => setEdge(e.target.checked ? { powerPct: s.powerPct, speedMmPerS: Math.max(1, Math.round(s.speedMmPerS * 0.6)), frequencyKhz: s.frequencyKhz, passes: 2 } : null)} /><span>Trace the outlines after filling</span></label>
        {edge && edge.passes > 0 && <div className="fd-lc-row fd-lc-row-tight">
          <label className="fd-lc-field"><span>Outline passes</span><Input type="number" min={1} max={200} step={1} value={edge.passes} disabled={locked} onChange={e => setEdge({ ...edge, passes: num(e.target.value, edge.passes) })} /></label>
          <label className="fd-lc-field"><span>Outline speed (mm/s)</span><Input type="number" min={1} max={20000} value={edge.speedMmPerS} disabled={locked} onChange={e => setEdge({ ...edge, speedMmPerS: num(e.target.value, edge.speedMmPerS) })} /></label>
          <label className="fd-lc-field"><span>Outline power (%)</span><Input type="number" min={0} max={100} value={edge.powerPct} disabled={locked} onChange={e => setEdge({ ...edge, powerPct: num(e.target.value, edge.powerPct) })} /></label>
        </div>}
        <div className="fd-lc-actions">
          <Button variant="primary" disabled={locked || !dirty} onClick={() => void save("settings", { settings: s, edge })}>{busy === "settings" && <Spinner />}Save job settings</Button>
          {dirty && <Button variant="ghost" disabled={locked} onClick={() => { setS(job.settings); setEdge(job.edge); }}>Undo changes</Button>}
        </div>
        {job.warnings.map(w => <p key={w} className="fd-lc-warn">{w}</p>)}
        {error && <p className="fd-lc-error" role="alert">{error}</p>}
      </div>
    </div>
  </div>;
}

/** Open an SVG or DXF drawing as the laser job, with its size, turn and mirror. */
export function DrawingImport({ busy: cellBusy }: { busy: boolean }) {
  const act = useLaserCellAction();
  const job = useLaserJob(true);
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [width, setWidth] = useState("");
  const [rotate, setRotate] = useState(0);
  const [mirror, setMirror] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const send = async (f: { name: string; text: string }, opts: { widthMm?: number; rotateDeg: number; mirror: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      const result = await act<{ job: LaserJobView; warnings: string[] }>({ action: "import_art", fileName: f.name, format: /\.dxf$/i.test(f.name) ? "dxf" : "svg", text: f.text, ...opts });
      setNotes(result.warnings ?? []);
      if (!opts.widthMm) setWidth(result.job.boardMm.width.toFixed(1));
      await job.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message.replace(/^Error:\s*/, "") : String(e));
    } finally {
      setBusy(false);
    }
  };
  const open = async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.size > 20 * 1024 * 1024) { setError("That file is over 20 MB; simplify the drawing first."); return; }
    const f = { name: picked.name, text: await picked.text() };
    setFile(f);
    setRotate(0);
    setMirror(false);
    await send(f, { rotateDeg: 0, mirror: false });
  };
  const apply = (next: { width?: string; rotate?: number; mirror?: boolean }) => {
    const w = next.width ?? width, r = next.rotate ?? rotate, m = next.mirror ?? mirror;
    if (!file) return;
    const widthMm = Number(w);
    void send(file, { ...(widthMm > 0 ? { widthMm } : {}), rotateDeg: r, mirror: m });
  };
  const locked = cellBusy || busy;
  return <div className="fd-lc-import">
    <div className="fd-lc-actions">
      <label className="fd-lc-file" data-disabled={locked || undefined}>
        <input type="file" accept=".svg,.dxf,image/svg+xml" disabled={locked} onChange={e => { void open(e.target.files?.[0]); e.target.value = ""; }} />
        <span>{busy && <Spinner />}{file ? "Open another drawing…" : "Open a drawing (SVG or DXF)…"}</span>
      </label>
      {file && <span className="fd-lc-note">{file.name}</span>}
    </div>
    {file && <div className="fd-lc-row fd-lc-row-tight">
      <label className="fd-lc-field"><span>Width (mm, keeps proportions)</span><Input type="number" min={0.1} step={0.1} value={width} disabled={locked} onChange={e => setWidth(e.target.value)} onBlur={() => apply({})} onKeyDown={e => { if (e.key === "Enter") apply({}); }} /></label>
      <label className="fd-lc-field"><span>Turn</span>
        <Select value={String(rotate)} disabled={locked} onChange={e => { const r = Number(e.target.value); setRotate(r); apply({ rotate: r }); }}>
          {[0, 90, 180, 270].map(r => <option key={r} value={r}>{r}°</option>)}
        </Select>
      </label>
      <label className="fd-lc-check fd-lc-check-inline"><input type="checkbox" checked={mirror} disabled={locked} onChange={e => { setMirror(e.target.checked); apply({ mirror: e.target.checked }); }} /><span>Mirror</span></label>
    </div>}
    {notes.map(n => <p key={n} className="fd-lc-warn">{n}</p>)}
    {error && <p className="fd-lc-error" role="alert">{error}</p>}
  </div>;
}
