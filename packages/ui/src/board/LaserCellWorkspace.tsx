import { useEffect, useState } from "react";
import {
  LASER_CELL_STEPS,
  LASER_DRIVER_LABELS,
  formatDuration,
  useLaserCell,
  useLaserCellAction,
  useSerialPorts,
  type LaserCellDriver,
  type LaserCellRunMode,
  type LaserCellSnapshot,
  type LaserCellTeachName,
} from "@fabdesk/client-core";
import { Button, EmptyState, Input, Select, Spinner } from "../components/ui";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import "./laser-cell.css";

type CopperSummary = {
  preset: string;
  side: "F" | "B";
  mode: "isolation" | "full";
  mirror: boolean;
  boardMm: { width: number; height: number };
  areaMm2: { board: number; copper: number; ablate: number };
  estimatedSeconds: number;
  settings: Record<"ablate" | "edge" | "clean", { powerPct: number; speedMmPerS: number; frequencyKhz: number; passes: number; intervalMm: number }>;
  warnings: string[];
  files: string[];
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return <label className="fd-laser-field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run, setError };
}

function CopperJobPanel({ projectId, onUse, onStudio }: { projectId: string; onUse: (summary: CopperSummary) => Promise<void>; onStudio: (() => Promise<void>) | null }) {
  const act = useLaserCellAction();
  const { busy, error, run } = useBusy();
  const [side, setSide] = useState<"F" | "B">("F");
  const [mode, setMode] = useState<"isolation" | "full">("isolation");
  const [isolation, setIsolation] = useState("0.4");
  const [preset, setPreset] = useState<"" | "omni-x-6w-70mm" | "omni-x-6w-150mm">("");
  const [summary, setSummary] = useState<CopperSummary | null>(null);
  const make = () => run("export", async () => {
    const result = await act<CopperSummary>({ projectId, side, mode, isolationMm: Number(isolation), ...(preset ? { preset } : {}) }, "export_laser_copper");
    setSummary(result);
  });
  return <section className="fd-laser-panel">
    <h3>1 · Copper job from this board</h3>
    <p className="fd-laser-note">fabPlane turns the board's copper into the laser job: a ring of copper is removed around every trace and pad (isolation), or all spare copper (full).</p>
    <div className="fd-laser-grid">
      <Field label="Copper side"><Select value={side} onChange={e => setSide(e.target.value as "F" | "B")}><option value="F">Top (F.Cu)</option><option value="B">Bottom (B.Cu, mirrored)</option></Select></Field>
      <Field label="Removal"><Select value={mode} onChange={e => setMode(e.target.value as "isolation" | "full")}><option value="isolation">Isolation ring (fast)</option><option value="full">All spare copper</option></Select></Field>
      {mode === "isolation" && <Field label="Ring width (mm)"><Input type="number" min={0.1} max={5} step={0.05} value={isolation} onChange={e => setIsolation(e.target.value)} /></Field>}
      <Field label="Lens"><Select value={preset} onChange={e => setPreset(e.target.value as typeof preset)}><option value="">Auto (70 mm if it fits)</option><option value="omni-x-6w-70mm">70 mm lens</option><option value="omni-x-6w-150mm">150 mm lens</option></Select></Field>
    </div>
    <div className="fd-laser-actions">
      <Button size="sm" onClick={make} disabled={!!busy}>{busy === "export" ? <Spinner /> : null}Make laser job</Button>
      {summary && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => run("use", () => onUse(summary))}>Use this job in the cell</Button>}
      {summary && onStudio && <Button size="sm" variant="secondary" disabled={!!busy} title="Starts ComMarker Studio if needed, imports this job at its true size and place, applies the fill and the settings above, then reads them back" onClick={() => run("studio", onStudio)}>Load into ComMarker Studio</Button>}
    </div>
    {error && <p className="fd-laser-error" role="alert">{error}</p>}
    {summary && <div className="fd-laser-summary">
      <p><strong>{summary.boardMm.width} × {summary.boardMm.height} mm</strong> · {summary.areaMm2.ablate} mm² of copper to remove · about <strong>{formatDuration(summary.estimatedSeconds)}</strong> per board · {summary.preset.replace("omni-x-6w-", "")} lens{summary.mirror ? " · mirrored" : ""}</p>
      <table className="fd-laser-table">
        <thead><tr><th>Pass</th><th>Power</th><th>Speed</th><th>Frequency</th><th>Line spacing</th><th>Passes</th></tr></thead>
        <tbody>
          {(["ablate", "edge", "clean"] as const).map(key => {
            const s = summary.settings[key];
            return <tr key={key}><td>{key === "ablate" ? "Remove copper (cross-hatch fill)" : key === "edge" ? "Edge cleanup (outline)" : "Final clean (fill)"}</td><td>{s.powerPct}%</td><td>{s.speedMmPerS} mm/s</td><td>{s.frequencyKhz} kHz</td><td>{key === "edge" ? "—" : `${s.intervalMm} mm`}</td><td>{s.passes}</td></tr>;
          })}
        </tbody>
      </table>
      <p className="fd-laser-note">Starting points for the Omni X 6 W, focused on the copper (autofocus, 0 offset). Run a material test on a scrap of the same blank, check with a meter that neighbouring traces are isolated, then add passes if copper remains.</p>
      {summary.warnings.map(w => <p key={w} className="fd-laser-warn">{w}</p>)}
      <ul className="fd-laser-files">{summary.files.map(f => <li key={f}><code>{f}</code></li>)}</ul>
    </div>}
  </section>;
}

function LaserPanel({ snap }: { snap: LaserCellSnapshot }) {
  const act = useLaserCellAction();
  const ports = useSerialPorts(true);
  const { busy, error, run } = useBusy();
  const l = snap.config.laser;
  const [draft, setDraft] = useState(l);
  useEffect(() => setDraft(snap.config.laser), [snap.config.laser]);
  const save = () => run("save", () => act({ action: "configure", laser: draft }));
  return <section className="fd-laser-panel">
    <h3>2 · Laser</h3>
    <p className="fd-laser-state" data-state={snap.laser?.state ?? "offline"}>{snap.laser ? `${snap.laser.state} — ${snap.laser.detail}` : "Not checked"}</p>
    <div className="fd-laser-grid">
      <Field label="Control through"><Select value={draft.driver} disabled={snap.run.active} onChange={e => setDraft({ ...draft, driver: e.target.value as LaserCellDriver })}>{(Object.keys(LASER_DRIVER_LABELS) as LaserCellDriver[]).map(d => <option key={d} value={d}>{LASER_DRIVER_LABELS[d]}</option>)}</Select></Field>
      {draft.driver === "studio-footswitch" && <>
        <Field label="Relay type"><Select value={draft.relayKind} onChange={e => setDraft({ ...draft, relayKind: e.target.value as "lcus" | "arduino" })}><option value="lcus">USB relay board (LCUS / CH340)</option><option value="arduino">Arduino / ESP32 + relay module</option></Select></Field>
        <Field label="Relay port" hint="The relay contact goes in parallel with the Omni X foot switch"><Select value={draft.relayPort ?? ""} onChange={e => setDraft({ ...draft, relayPort: e.target.value || null })}><option value="">Choose…</option>{(ports.data ?? []).map(p => <option key={p.path} value={p.path}>{p.label}</option>)}</Select></Field>
        {draft.relayKind === "lcus" && <Field label="Relay channel"><Input type="number" min={1} max={8} value={draft.relayChannel} onChange={e => setDraft({ ...draft, relayChannel: Number(e.target.value) })} /></Field>}
        <Field label="Job time (s)" hint="Studio cannot report 'done'. Use Studio's time estimate, then time the first board"><Input type="number" min={1} value={draft.markSeconds} onChange={e => setDraft({ ...draft, markSeconds: Number(e.target.value) })} /></Field>
        <Field label="Safety margin (s)"><Input type="number" min={0} value={draft.marginSeconds} onChange={e => setDraft({ ...draft, marginSeconds: Number(e.target.value) })} /></Field>
      </>}
      {draft.driver === "studio-window" && <>
        <Field label="Board centre X (mm)" hint="Where the jig holds the board's centre in Studio's X / Y (0,0 = middle of the field)"><Input type="number" step={0.1} value={draft.studioBoardCenterMm.x} onChange={e => setDraft({ ...draft, studioBoardCenterMm: { ...draft.studioBoardCenterMm, x: Number(e.target.value) } })} /></Field>
        <Field label="Board centre Y (mm)"><Input type="number" step={0.1} value={draft.studioBoardCenterMm.y} onChange={e => setDraft({ ...draft, studioBoardCenterMm: { ...draft.studioBoardCenterMm, y: Number(e.target.value) } })} /></Field>
        <Field label="Job finished when" hint="Studio's Start button is watched; if that does not work on your Studio, use the job time"><Select value={draft.studioCompletion} onChange={e => setDraft({ ...draft, studioCompletion: e.target.value as "watch" | "timer" })}><option value="watch">Studio shows it is done</option><option value="timer">Job time has passed</option></Select></Field>
        <Field label="Job time (s)" hint="Used when finished = job time; Studio's estimate, then time the first board"><Input type="number" min={1} value={draft.markSeconds} onChange={e => setDraft({ ...draft, markSeconds: Number(e.target.value) })} /></Field>
        <Field label="Safety margin (s)"><Input type="number" min={0} value={draft.marginSeconds} onChange={e => setDraft({ ...draft, marginSeconds: Number(e.target.value) })} /></Field>
        <Field label="Time limit (min)"><Input type="number" min={1} value={draft.markTimeoutMinutes} onChange={e => setDraft({ ...draft, markTimeoutMinutes: Number(e.target.value) })} /></Field>
      </>}
      {draft.driver === "lightburn" && <>
        <Field label="Job file (.lbrn2)" hint="Use 'Use this job in the cell', or paste a full path"><Input value={draft.jobPath ?? ""} onChange={e => setDraft({ ...draft, jobPath: e.target.value || null })} /></Field>
        <Field label="Time limit (min)"><Input type="number" min={1} value={draft.markTimeoutMinutes} onChange={e => setDraft({ ...draft, markTimeoutMinutes: Number(e.target.value) })} /></Field>
      </>}
    </div>
    <div className="fd-laser-actions">
      <Button size="sm" onClick={save} disabled={!!busy || snap.run.active}>Save laser settings</Button>
      <Button size="sm" variant="ghost" onClick={() => void ports.refetch()}>Refresh ports</Button>
    </div>
    {l.driver === "studio-footswitch" && <div className="fd-laser-actions" aria-label="Foot switch test">
      <span className="fd-laser-note">Foot switch:</span>
      <Button size="sm" variant="secondary" disabled={!!busy || snap.run.active || !l.relayPort} title="One 250 ms press: Studio runs its loaded job once" onClick={() => run("press", () => act({ action: "footswitch_press" }))}>Press once</Button>
      <Button size="sm" variant="secondary" disabled={!!busy || snap.run.active || !l.relayPort} onClick={() => run("hold", () => act({ action: "footswitch_hold" }))}>Hold down</Button>
      <Button size="sm" variant="secondary" disabled={!!busy || !l.relayPort} onClick={() => run("release", () => act({ action: "footswitch_release" }))}>Release</Button>
    </div>}
    {draft.driver === "studio-footswitch" && <p className="fd-laser-note">In ComMarker Studio: load the job (import the SVG from step 1, or the LightBurn file), set the same speed/power/passes, enable foot-switch start, and leave Studio open. Each start from the relay runs that job once.</p>}
    {draft.driver === "studio-window" && <p className="fd-laser-note">Start ComMarker Studio with the “ComMarker Studio (fabPlane)” desktop shortcut (not as administrator, or fabPlane cannot press its buttons), connect the Omni X, open the job and leave Studio on that page. “Load into ComMarker Studio” (step 1) builds the job in Studio: import at true size and place, hatch fill, speed/frequency/pulse/passes. fabPlane presses Studio's Start(F2) button, watches it until the job ends, and stops the cycle if Studio shows a dialog. Keep the PC unlocked during a run.</p>}
    {draft.driver === "lightburn" && <p className="fd-laser-note">LightBurn: Edit → Settings → enable UDP automation, connect the Omni X as a galvo device. fabPlane loads the job, presses Start and waits until LightBurn reports idle.</p>}
    {error && <p className="fd-laser-error" role="alert">{error}</p>}
  </section>;
}

function ArmPanel({ snap }: { snap: LaserCellSnapshot }) {
  const act = useLaserCellAction();
  const ports = useSerialPorts(true);
  const { busy, error, run } = useBusy();
  const locked = snap.run.active || !!busy;
  return <section className="fd-laser-panel">
    <h3>3 · Robot arm (ElRobot)</h3>
    <div className="fd-laser-grid">
      <Field label="Servo board port"><Select value={snap.config.arm.port ?? ""} disabled={locked || snap.arm.connected} onChange={e => void run("port", () => act({ action: "configure", arm: { port: e.target.value || null } }))}><option value="">Choose…</option>{(ports.data ?? []).map(p => <option key={p.path} value={p.path}>{p.label}</option>)}</Select></Field>
      <Field label="Servo ids" hint="Joints, then the gripper"><Input value={`${snap.config.arm.jointIds.join(",")} / ${snap.config.arm.gripperId}`} readOnly /></Field>
    </div>
    <div className="fd-laser-actions">
      {snap.arm.connected
        ? <Button size="sm" variant="secondary" disabled={locked} onClick={() => run("disconnect", () => act({ action: "disconnect" }))}>Disconnect</Button>
        : <Button size="sm" disabled={locked || !snap.config.arm.port} onClick={() => run("connect", () => act({ action: "connect" }))}>{busy === "connect" ? <Spinner /> : null}Connect arm</Button>}
      <Button size="sm" variant="secondary" disabled={locked || !snap.arm.connected} onClick={() => run("relax", () => act({ action: "relax" }))} title="Motors off so you can move the arm by hand. Hold it first — it will drop.">Relax for teaching</Button>
      <Button size="sm" variant="secondary" disabled={locked || !snap.arm.connected} onClick={() => run("hold", () => act({ action: "hold" }))}>Hold position</Button>
    </div>
    {snap.arm.error && <p className="fd-laser-error">{snap.arm.error}</p>}
    {snap.arm.joints && <table className="fd-laser-table fd-laser-joints">
      <thead><tr><th>Servo</th><th>Position</th><th>Temp</th><th>Volts</th><th>Load</th></tr></thead>
      <tbody>{snap.arm.joints.map(j => <tr key={j.id} data-hot={j.temperature >= 55 || undefined}><td>{j.id === snap.config.arm.gripperId ? `${j.id} (gripper)` : j.id}</td><td>{j.position}</td><td>{j.temperature} °C</td><td>{j.voltage.toFixed(1)} V</td><td>{j.load.toFixed(1)}%</td></tr>)}</tbody>
    </table>}
    {error && <p className="fd-laser-error" role="alert">{error}</p>}
  </section>;
}

function TeachPanel({ snap }: { snap: LaserCellSnapshot }) {
  const act = useLaserCellAction();
  const { busy, error, run } = useBusy();
  const locked = snap.run.active || !!busy || !snap.arm.connected;
  const teach = (name: LaserCellTeachName) => run(`teach-${name}`, () => act({ action: "teach", name }));
  return <section className="fd-laser-panel">
    <h3>4 · Teach the stations</h3>
    <p className="fd-laser-note">Press <em>Relax</em>, move the arm by hand to each station, then press <em>Teach</em>. "Above" stations are the same spot about 3 cm higher, so the arm comes straight down. Put a 3D-printed corner jig on the laser bed: the board always lands in the same place, so the job lines up every time.</p>
    <ol className="fd-laser-poses">
      {snap.poses.map(pose => <li key={pose.name} data-taught={pose.taught || undefined}>
        <span>{pose.label}</span>
        <i>{pose.taught ? "taught" : "not taught"}</i>
        <Button size="sm" variant="secondary" disabled={locked} onClick={() => teach(pose.name)}>Teach</Button>
        <Button size="sm" variant="ghost" disabled={locked || !pose.taught} onClick={() => run(`move-${pose.name}`, () => act({ action: "move", name: pose.name }))}>Go</Button>
      </li>)}
      {(["gripperOpen", "gripperClosed"] as const).map(name => {
        const taught = snap.config.poses[name] !== undefined;
        return <li key={name} data-taught={taught || undefined}>
          <span>{name === "gripperOpen" ? "Gripper open" : "Gripper closed (empty)"}</span>
          <i>{taught ? `taught (${snap.config.poses[name]})` : "not taught"}</i>
          <Button size="sm" variant="secondary" disabled={locked} onClick={() => teach(name)}>Teach</Button>
        </li>;
      })}
    </ol>
    {error && <p className="fd-laser-error" role="alert">{error}</p>}
  </section>;
}

function SafetyPanel({ snap }: { snap: LaserCellSnapshot }) {
  const act = useLaserCellAction();
  const { busy, error, run } = useBusy();
  return <section className="fd-laser-panel fd-laser-safety">
    <h3>UV safety</h3>
    <p>The Omni X stops when its lid opens. For the arm to reach the bed the lid must stay open or its cover sensor must be off, and then the 355 nm UV beam and its reflections are <strong>no longer enclosed</strong>. UV burns eyes and skin before you notice.</p>
    <ul>
      <li>Enclose the laser and the arm in a UV-blocking guard (orange/amber acrylic rated for 355 nm), with the door wired to stop the laser.</li>
      <li>Wear UV glasses rated OD 4+ at 355 nm near the cell. Keep fume extraction on: FR-4 and copper smoke is harmful.</li>
      <li>fabPlane cannot stop the beam remotely on the ComMarker Studio or LightBurn route. Keep the Omni X E-stop within reach.</li>
    </ul>
    <label className="fd-laser-check">
      <input type="checkbox" checked={snap.config.safetyConfirmed} disabled={!!busy || snap.run.active} onChange={e => void run("safety", () => act({ action: "configure", safetyConfirmed: e.target.checked }))} />
      A UV-blocking guard encloses the laser and arm, and the E-stop is within reach
    </label>
    {error && <p className="fd-laser-error" role="alert">{error}</p>}
  </section>;
}

function RunBar({ snap }: { snap: LaserCellSnapshot }) {
  const act = useLaserCellAction();
  const { busy, error, run } = useBusy();
  const [boards, setBoards] = useState(1);
  const [mode, setMode] = useState<LaserCellRunMode>("dry-run");
  const r = snap.run;
  return <section className="fd-laser-run" aria-label="Run the cell">
    <div className="fd-laser-run-controls">
      <Field label="Boards"><Input type="number" min={1} max={500} value={boards} disabled={r.active} onChange={e => setBoards(Math.max(1, Number(e.target.value)))} /></Field>
      <Field label="Mode"><Select value={mode} disabled={r.active} onChange={e => setMode(e.target.value as LaserCellRunMode)}>
        <option value="dry-run">Dry run (arm only, laser off)</option>
        <option value="cycle">Full cycle (arm + laser)</option>
        <option value="laser-only">Laser only (board placed by hand)</option>
      </Select></Field>
      {r.active
        ? <Button className="fd-laser-stop" onClick={() => run("stop", () => act({ action: "stop" }))}>Stop</Button>
        : <Button disabled={!!busy} onClick={() => run("run", () => act({ action: "run", boards, mode }))}>{busy === "run" ? <Spinner /> : null}Start</Button>}
    </div>
    <ol className="fd-laser-steps">
      {LASER_CELL_STEPS.map(s => <li key={s.step} data-state={s.step === r.step ? (r.active ? "active" : r.error ? "failed" : "done") : r.visited.includes(s.step) ? "done" : undefined}>{s.label}</li>)}
    </ol>
    <p className="fd-laser-run-note">
      {r.active ? `Board ${r.board} of ${r.boards}: ${r.note ?? ""}${r.progress > 0 && r.progress < 1 ? ` (${Math.round(r.progress * 100)}%)` : ""}`
        : r.error ? `Stopped: ${r.error}`
        : r.done ? `Finished ${r.done} of ${r.boards} board(s).`
        : snap.missing.length && mode !== "laser-only" ? `Teach first: ${snap.missing.join(", ")}` : "Ready. Start with a dry run."}
    </p>
    {error && <p className="fd-laser-error" role="alert">{error}</p>}
  </section>;
}

export function LaserCellWorkspace({ projectId }: { projectId: string }) {
  const cell = useLaserCell();
  const act = useLaserCellAction();
  const snap = cell.data;
  useAssistantSurface(snap ? {
    projectId,
    label: "Laser cell",
    priority: 4,
    details: JSON.stringify({ arm: snap.arm.connected, laser: snap.laser?.state, driver: snap.config.laser.driver, missing: snap.missing, run: snap.run, safetyConfirmed: snap.config.safetyConfirmed }),
  } : null);
  if (cell.isPending) return <div className="fd-laser-workspace"><Spinner /></div>;
  if (cell.isError || !snap) return <EmptyState title="The laser cell is not available">{cell.error instanceof Error ? cell.error.message : "Start fabPlane's local core to drive the arm and laser."}</EmptyState>;
  const loadIntoStudio = snap.config.laser.driver === "studio-window" ? async () => { await act({ action: "studio_load_job", project: projectId }); } : null;
  const useJob = async (summary: CopperSummary) => {
    await act({ action: "use_job", project: projectId, job: summary.files.find(f => f.endsWith(".lbrn2")) });
  };
  return <div className="fd-laser-workspace" data-testid="laser-cell-workspace">
    <RunBar snap={snap} />
    <div className="fd-laser-columns">
      <div className="fd-laser-column">
        <CopperJobPanel projectId={projectId} onUse={useJob} onStudio={loadIntoStudio} />
        <LaserPanel snap={snap} />
        <SafetyPanel snap={snap} />
      </div>
      <div className="fd-laser-column">
        <ArmPanel snap={snap} />
        <TeachPanel snap={snap} />
        <section className="fd-laser-panel">
          <h3>Log</h3>
          <ol className="fd-laser-log">{snap.log.slice().reverse().map((entry, i) => <li key={`${entry.at}-${i}`} data-level={entry.level}><time>{new Date(entry.at).toLocaleTimeString()}</time> {entry.message}</li>)}</ol>
          <p className="fd-laser-note">Settings are saved in <code>{snap.configPath}</code></p>
        </section>
      </div>
    </div>
  </div>;
}
