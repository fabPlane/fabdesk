/**
 * Laser Controller: the whole laser cell (ElRobot arm + ComMarker Omni X) on one simple page.
 * Shown in its own desktop window (apps/desktop/src/main/laser-window.ts), or inline in the
 * "Laser cell" workspace when there is no desktop window (browser client).
 *
 *   1 Job  — pick a project, make the copper job, load it into ComMarker Studio
 *   2 Run  — boards, mode, UV-guard check, Start / Stop, progress
 *   Arm setup / Settings / Log — folded away until needed
 *
 * Every action is one `laser_cell` (or `export_laser_copper`) tool call; the core does the work.
 */
import { useEffect, useState, type ReactNode } from "react";
import {
  LASER_CELL_STEPS,
  errorPayload,
  formatDuration,
  useLaserCell,
  useLaserCellAction,
  useProjects,
  useSerialPorts,
  type LaserCellConfig,
  type LaserCellDriver,
  type LaserCellRunMode,
  type LaserCellSnapshot,
  type LaserCellTeachName,
} from "@fabdesk/client-core";
import { Button, Input, Select, Spinner } from "../components/ui";
import "./laser-controller.css";

const PROJECT_KEY = "fabdesk.laser.project";

/** Remembers the project chosen for the laser (shared with the main window, which sets it before opening this one). */
export function setLaserProject(projectId: string): void {
  try { localStorage.setItem(PROJECT_KEY, projectId); } catch { /* storage unavailable */ }
}

const ROUTES: Array<{ id: LaserCellDriver; label: string }> = [
  { id: "studio-window", label: "ComMarker Studio (recommended)" },
  { id: "studio-footswitch", label: "ComMarker Studio + foot-switch relay" },
  { id: "lightburn", label: "LightBurn" },
  { id: "simulator", label: "Simulator (no laser)" },
];

const MODES: Array<{ id: LaserCellRunMode; label: string }> = [
  { id: "laser-only", label: "Laser only (I place the board)" },
  { id: "cycle", label: "Full cycle (arm loads the board)" },
  { id: "dry-run", label: "Arm test (laser stays off)" },
];

type JobSummary = { boardMm: { width: number; height: number }; estimatedSeconds: number; preset: string; warnings: string[] };

/** The cell's own message (e.g. "there is no copper on B.Cu"), not the app's generic retry advice. */
const errorText = (e: unknown) => errorPayload(e).message.replace(/^Error:s*/, "") || "Something went wrong";

/** One action at a time per section, with its error. */
function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  };
  return { busy, error, run };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="fd-lc-field"><span>{label}</span>{children}</label>;
}

function Problem({ text }: { text: string | null }) {
  return text ? <p className="fd-lc-error" role="alert">{text}</p> : null;
}

// ------------------------------------------------------------------ status

function StatusChips({ snap }: { snap: LaserCellSnapshot }) {
  const laser = snap.laser;
  const laserText = !laser ? "Checking…" : laser.state === "idle" ? "Ready" : laser.state === "busy" ? "Busy" : laser.state === "offline" ? "Not connected" : "Needs attention";
  return <div className="fd-lc-chips">
    <span className="fd-lc-chip" data-ok={laser?.state === "idle" || undefined} data-warn={laser?.state === "busy" || undefined} title={laser?.detail}>Laser: {laserText}</span>
    <span className="fd-lc-chip" data-ok={snap.arm.connected || undefined}>Arm: {snap.arm.connected ? "Connected" : "Not connected"}</span>
    <span className="fd-lc-chip" data-ok={snap.config.safetyConfirmed || undefined}>UV guard: {snap.config.safetyConfirmed ? "Confirmed" : "Not confirmed"}</span>
  </div>;
}

// ------------------------------------------------------------------ 1 · job

function JobStep({ snap }: { snap: LaserCellSnapshot }) {
  const act = useLaserCellAction();
  const projects = useProjects();
  const { busy, error, run } = useAction();
  const [projectId, setProjectId] = useState(() => { try { return localStorage.getItem(PROJECT_KEY) ?? ""; } catch { return ""; } });
  const [side, setSide] = useState<"F" | "B">("F");
  const [ring, setRing] = useState("0.4");
  const [job, setJob] = useState<JobSummary | null>(null);
  const [inStudio, setInStudio] = useState<Record<string, unknown> | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  // The main window sets the project before opening this window.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === PROJECT_KEY && e.newValue) setProjectId(e.newValue); };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const choose = (id: string) => { setProjectId(id); setJob(null); setInStudio(null); setLaserProject(id); };
  const route = snap.config.laser.driver;
  const make = () => run("make", async () => {
    setInStudio(null);
    setJob(await act<JobSummary>({ projectId, side, mode: "isolation", isolationMm: Number(ring) }, "export_laser_copper"));
  });
  const load = () => run("load", async () => {
    const result = await act<{ values?: Record<string, unknown>; log?: string[] }>({ action: "studio_load_job", project: projectId });
    setInStudio(result.values ?? {});
    setNotes((result.log ?? []).filter(line => /check in Studio|no Power|not found|greyed/.test(line)));
  });
  const useForLightBurn = () => run("use", () => act({ action: "use_job", project: projectId }));
  const v = inStudio ?? {};
  return <section className="fd-lc-step">
    <h2><b>1</b> Job</h2>
    <div className="fd-lc-row">
      <Field label="Project">
        <Select value={projectId} onChange={e => choose(e.target.value)}>
          <option value="">Choose a project…</option>
          {(projects.data ?? []).filter(p => !p.isDraft).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </Field>
      <Field label="Copper side">
        <Select value={side} onChange={e => setSide(e.target.value as "F" | "B")}><option value="F">Top</option><option value="B">Bottom (mirrored)</option></Select>
      </Field>
      <Field label="Ring around traces (mm)"><Input type="number" min={0.1} max={5} step={0.05} value={ring} onChange={e => setRing(e.target.value)} /></Field>
    </div>
    <div className="fd-lc-actions">
      <Button variant="primary" disabled={!projectId || !!busy} onClick={make}>{busy === "make" && <Spinner />}Make laser job</Button>
      {route === "studio-window" && <Button disabled={!projectId || !!busy || snap.run.active} onClick={load}>{busy === "load" && <Spinner />}Load into ComMarker Studio</Button>}
      {route === "lightburn" && <Button disabled={!projectId || !!busy} onClick={useForLightBurn}>Use for LightBurn</Button>}
    </div>
    {job && <p className="fd-lc-note">Job ready: <b>{job.boardMm.width} × {job.boardMm.height} mm</b>, about <b>{formatDuration(job.estimatedSeconds)}</b> per board, {job.preset.replace("omni-x-6w-", "").replace("mm", " mm")} lens.</p>}
    {job?.warnings.map(w => <p key={w} className="fd-lc-warn">{w}</p>)}
    {inStudio && <p className="fd-lc-note fd-lc-good">In Studio: {String(v["width"])} × {String(v["height"])} mm at X {String(v["x"])}, Y {String(v["y"])} · speed {String(v["speed"])} mm/s · {String(v["frequency"])} kHz · {String(v["passes"])} passes · fill {String(v["interval"])} mm. Check the position with Studio's Preview before the first board.</p>}
    {notes.map(n => <p key={n} className="fd-lc-warn">{n}</p>)}
    <Problem text={error} />
  </section>;
}

// ------------------------------------------------------------------ 2 · run

function RunStep({ snap }: { snap: LaserCellSnapshot }) {
  const act = useLaserCellAction();
  const { busy, error, run } = useAction();
  const [boards, setBoards] = useState(1);
  const [mode, setMode] = useState<LaserCellRunMode>("laser-only");
  const r = snap.run;
  const studioClosed = snap.config.laser.driver === "studio-window" && snap.laser?.state === "offline" && /not open/.test(snap.laser.detail);
  const needsGuard = mode !== "dry-run" && !snap.config.safetyConfirmed;
  const status = r.active
    ? `Board ${r.board} of ${r.boards}: ${r.note ?? "working…"}`
    : r.error ? `Stopped: ${r.error}`
    : r.done ? `Finished ${r.done} of ${r.boards} board(s).`
    : snap.laser && snap.laser.state !== "idle" && mode !== "dry-run" ? `Laser: ${snap.laser.detail}`
    : mode !== "laser-only" && snap.missing.length ? `Teach the arm first (Arm setup): ${snap.missing.join(", ")}`
    : "Ready.";
  return <section className="fd-lc-step">
    <h2><b>2</b> Run</h2>
    <div className="fd-lc-row">
      <Field label="Boards"><Input type="number" min={1} max={500} value={boards} disabled={r.active} onChange={e => setBoards(Math.max(1, Number(e.target.value) || 1))} /></Field>
      <Field label="Mode"><Select value={mode} disabled={r.active} onChange={e => setMode(e.target.value as LaserCellRunMode)}>{MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}</Select></Field>
    </div>
    <label className="fd-lc-check">
      <input type="checkbox" checked={snap.config.safetyConfirmed} disabled={!!busy || r.active} onChange={e => void run("guard", () => act({ action: "configure", safetyConfirmed: e.target.checked }))} />
      <span>The UV guard is closed, everyone nearby wears UV glasses, and the Omni X E-stop is within reach.</span>
    </label>
    <div className="fd-lc-actions">
      {r.active
        ? <Button variant="danger" className="fd-lc-big" onClick={() => run("stop", () => act({ action: "stop" }))}>Stop</Button>
        : <Button variant="primary" className="fd-lc-big" disabled={!!busy || needsGuard} title={needsGuard ? "Confirm the UV guard first" : undefined} onClick={() => run("start", () => act({ action: "run", boards, mode }))}>{busy === "start" && <Spinner />}Start</Button>}
      {studioClosed && <Button disabled={!!busy} onClick={() => run("studio", () => act({ action: "studio_open" }))}>{busy === "studio" && <Spinner />}Open ComMarker Studio</Button>}
    </div>
    <ol className="fd-lc-progress">
      {LASER_CELL_STEPS.filter(s => mode !== "laser-only" || !["pick", "place", "clear", "unload"].includes(s.step)).map(s =>
        <li key={s.step} data-state={s.step === r.step ? (r.active ? "active" : r.error ? "failed" : "done") : r.visited.includes(s.step) ? "done" : undefined}>{s.label}</li>)}
    </ol>
    <p className="fd-lc-status" data-error={!!r.error || undefined}>{status}</p>
    <Problem text={error} />
  </section>;
}

// ------------------------------------------------------------------ arm setup

function ArmSetup({ snap }: { snap: LaserCellSnapshot }) {
  const act = useLaserCellAction();
  const ports = useSerialPorts(true);
  const { busy, error, run } = useAction();
  const locked = snap.run.active || !!busy;
  const teachable = !locked && snap.arm.connected;
  const teach = (name: LaserCellTeachName) => run(`teach-${name}`, () => act({ action: "teach", name }));
  return <div className="fd-lc-fold-body">
    <div className="fd-lc-row">
      <Field label="Servo board port">
        <Select value={snap.config.arm.port ?? ""} disabled={locked || snap.arm.connected} onChange={e => void run("port", () => act({ action: "configure", arm: { port: e.target.value || null } }))}>
          <option value="">Choose…</option>{(ports.data ?? []).map(p => <option key={p.path} value={p.path}>{p.label}</option>)}
        </Select>
      </Field>
    </div>
    <div className="fd-lc-actions">
      {snap.arm.connected
        ? <Button disabled={locked} onClick={() => run("disconnect", () => act({ action: "disconnect" }))}>Disconnect</Button>
        : <Button variant="primary" disabled={locked || !snap.config.arm.port} onClick={() => run("connect", () => act({ action: "connect" }))}>Connect arm</Button>}
      <Button disabled={!teachable} title="Motors off: hold the arm, it will drop" onClick={() => run("relax", () => act({ action: "relax" }))}>Relax (move by hand)</Button>
      <Button disabled={!teachable} onClick={() => run("hold", () => act({ action: "hold" }))}>Hold</Button>
      <Button variant="ghost" onClick={() => void ports.refetch()}>Refresh ports</Button>
    </div>
    {snap.arm.error && <p className="fd-lc-error">{snap.arm.error}</p>}
    <p className="fd-lc-note">Relax, move the arm by hand to each spot, press Teach. "Above" spots are about 3 cm higher.</p>
    <ul className="fd-lc-poses">
      {snap.poses.map(p => <li key={p.name} data-done={p.taught || undefined}>
        <span>{p.label}</span>
        <Button size="sm" disabled={!teachable} onClick={() => teach(p.name)}>Teach</Button>
        <Button size="sm" variant="ghost" disabled={!teachable || !p.taught} onClick={() => run(`go-${p.name}`, () => act({ action: "move", name: p.name }))}>Go</Button>
      </li>)}
      {(["gripperOpen", "gripperClosed"] as const).map(name => <li key={name} data-done={snap.config.poses[name] !== undefined || undefined}>
        <span>{name === "gripperOpen" ? "Gripper open" : "Gripper closed (empty)"}</span>
        <Button size="sm" disabled={!teachable} onClick={() => teach(name)}>Teach</Button>
        <span />
      </li>)}
    </ul>
    <Problem text={error} />
  </div>;
}

// ------------------------------------------------------------------ settings

function Settings({ snap }: { snap: LaserCellSnapshot }) {
  const act = useLaserCellAction();
  const ports = useSerialPorts(snap.config.laser.driver === "studio-footswitch");
  const { busy, error, run } = useAction();
  const [d, setD] = useState<LaserCellConfig["laser"]>(snap.config.laser);
  useEffect(() => setD(snap.config.laser), [snap.config.laser]);
  const num = (key: "markSeconds" | "marginSeconds" | "markTimeoutMinutes" | "relayChannel") => (e: React.ChangeEvent<HTMLInputElement>) => setD({ ...d, [key]: Number(e.target.value) });
  const saved = snap.config.laser;
  return <div className="fd-lc-fold-body">
    <div className="fd-lc-row">
      <Field label="Control the laser through">
        <Select value={d.driver} disabled={snap.run.active} onChange={e => setD({ ...d, driver: e.target.value as LaserCellDriver })}>{ROUTES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}</Select>
      </Field>
    </div>
    {d.driver === "studio-window" && <div className="fd-lc-row">
      <Field label="Board centre X on the laser (mm)"><Input type="number" step={0.1} value={d.studioBoardCenterMm.x} onChange={e => setD({ ...d, studioBoardCenterMm: { ...d.studioBoardCenterMm, x: Number(e.target.value) } })} /></Field>
      <Field label="Board centre Y on the laser (mm)"><Input type="number" step={0.1} value={d.studioBoardCenterMm.y} onChange={e => setD({ ...d, studioBoardCenterMm: { ...d.studioBoardCenterMm, y: Number(e.target.value) } })} /></Field>
      <Field label="Job is finished when">
        <Select value={d.studioCompletion} onChange={e => setD({ ...d, studioCompletion: e.target.value as "watch" | "timer" })}><option value="watch">Studio shows it is done</option><option value="timer">The job time has passed</option></Select>
      </Field>
    </div>}
    {d.driver === "studio-footswitch" && <div className="fd-lc-row">
      <Field label="Relay type">
        <Select value={d.relayKind} onChange={e => setD({ ...d, relayKind: e.target.value as "lcus" | "arduino" })}><option value="lcus">USB relay (LCUS / CH340)</option><option value="arduino">Arduino / ESP32</option></Select>
      </Field>
      <Field label="Relay port">
        <Select value={d.relayPort ?? ""} onChange={e => setD({ ...d, relayPort: e.target.value || null })}><option value="">Choose…</option>{(ports.data ?? []).map(p => <option key={p.path} value={p.path}>{p.label}</option>)}</Select>
      </Field>
      {d.relayKind === "lcus" && <Field label="Relay channel"><Input type="number" min={1} max={8} value={d.relayChannel} onChange={num("relayChannel")} /></Field>}
    </div>}
    {d.driver === "lightburn" && <div className="fd-lc-row">
      <Field label="LightBurn job file (.lbrn2)"><Input value={d.jobPath ?? ""} onChange={e => setD({ ...d, jobPath: e.target.value || null })} /></Field>
    </div>}
    {d.driver !== "simulator" && <div className="fd-lc-row">
      <Field label="Job time (s)"><Input type="number" min={1} value={d.markSeconds} onChange={num("markSeconds")} /></Field>
      <Field label="Extra wait after the job (s)"><Input type="number" min={0} value={d.marginSeconds} onChange={num("marginSeconds")} /></Field>
      <Field label="Give up after (min)"><Input type="number" min={1} value={d.markTimeoutMinutes} onChange={num("markTimeoutMinutes")} /></Field>
    </div>}
    <div className="fd-lc-actions">
      <Button variant="primary" disabled={!!busy || snap.run.active} onClick={() => run("save", () => act({ action: "configure", laser: d }))}>Save settings</Button>
      {saved.driver === "studio-footswitch" && <>
        <Button disabled={!!busy || snap.run.active || !saved.relayPort} title="One short press: Studio runs its loaded job once" onClick={() => run("press", () => act({ action: "footswitch_press" }))}>Test: press foot switch</Button>
        <Button disabled={!!busy || !saved.relayPort} onClick={() => run("release", () => act({ action: "footswitch_release" }))}>Release foot switch</Button>
      </>}
    </div>
    <Problem text={error} />
  </div>;
}

// ------------------------------------------------------------------ page

/** `inline`: inside the main window's workspace (browser client) rather than its own window. */
export function LaserController({ inline = false }: { inline?: boolean }) {
  const cell = useLaserCell();
  const snap = cell.data;
  const root = inline ? "fd-lc-root fd-lc-inline" : "fd-lc-root";
  if (cell.isPending) return <div className={root}><div className="fd-lc fd-lc-center"><Spinner /></div></div>;
  if (!snap) return <div className={root}><div className="fd-lc fd-lc-center"><p className="fd-lc-error">The laser cell is not available: {cell.error ? errorText(cell.error) : "start fabPlane's local core."}</p></div></div>;
  return <div className={root}><div className="fd-lc" data-testid="laser-controller">
    <header className="fd-lc-head">
      <h1>Laser Controller</h1>
      <StatusChips snap={snap} />
    </header>
    <JobStep snap={snap} />
    <RunStep snap={snap} />
    <details className="fd-lc-fold"><summary>Arm setup</summary><ArmSetup snap={snap} /></details>
    <details className="fd-lc-fold"><summary>Settings</summary><Settings snap={snap} /></details>
    <details className="fd-lc-fold"><summary>Log</summary>
      <ol className="fd-lc-log">{snap.log.slice(-40).reverse().map((l, i) => <li key={`${l.at}-${i}`} data-level={l.level}><time>{new Date(l.at).toLocaleTimeString()}</time> {l.message}</li>)}</ol>
    </details>
  </div></div>;
}
