/**
 * Adopt a board candidate (made by an edit, last-mile or review stage in a scratch folder) into the project.
 * Checkpoint, then the schematic sheets and project libraries the candidate changed (only while the project's copy is
 * still the one the candidate was computed from), then the PCB delta as one KiCad commit over IPC, read back.
 */
import { copyFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { jailPath, PROJECT_FILES } from "./fs";
import { saveBoardPoint } from "./board-history";
import { governor } from "./resources";
import { ToolError, type ToolContext } from "./registry";
import type { BoardAdoptResult } from "./services";
import { retainTaskCheckpoint } from "./task-checkpoints";

const sha256File = async (path: string) => {
  const b = await readFile(path).catch(() => null);
  return b ? createHash("sha256").update(b).digest("hex") : null;
};
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

/** Design files whose change a candidate may carry into the project (besides the PCB). */
const DESIGN_FILE = /\.(kicad_sch|kicad_sym)$|^(sym|fp)-lib-table$/;

/** sha256 of every design file directly in `dir`. */
export async function designFileHashes(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of await readdir(dir).catch(() => [] as string[]))
    if (DESIGN_FILE.test(name)) {
      const h = await sha256File(join(dir, name));
      if (h) out[name] = h;
    }
  return out;
}

/**
 * Where a stage recorded the project's design files when it computed the candidate: `origin.json`
 * (`{ project, files: {name: sha256} }`) beside or one folder above the candidate board. Absent = PCB only.
 */
export async function candidateOrigin(candidatePcb: string): Promise<{ project: string; files: Record<string, string> } | null> {
  for (const dir of [dirname(candidatePcb), dirname(dirname(candidatePcb))]) {
    const o = JSON.parse((await readFile(join(dir, "origin.json"), "utf8").catch(() => "")) || "null");
    if (o?.files) return o;
  }
  return null;
}

export type AdoptOutcome = {
  text: string;
  data: BoardAdoptResult & { checkpointId: string; target: string; clean: boolean; designFiles: string[]; timelinePoint: string | null };
  clean: boolean;
};

export async function adoptCandidate(ctx: ToolContext, input: { candidate: string; board?: string; reason: string }): Promise<AdoptOutcome> {
  const project = ctx.requireProject();
  const adopter = ctx.services.boardAdopt;
  if (!adopter) throw new ToolError("adopting a candidate board is unavailable in this runtime", "unavailable");
  const { candidate } = input;
  if (!candidate.endsWith(".kicad_pcb")) throw new ToolError("candidate must be a .kicad_pcb", "invalid_args");
  if (!(await stat(candidate).catch(() => null))?.isFile()) throw new ToolError(`candidate not found: ${candidate}`, "not_found");
  const target = await jailPath(project.dir, input.board ?? PROJECT_FILES.boardPcb);
  if (!target.endsWith(".kicad_pcb") || !(await stat(target).catch(() => null))?.isFile())
    throw new ToolError(`target board not found in the project: ${input.board ?? PROJECT_FILES.boardPcb}`, "not_found");
  if (resolve(candidate) === resolve(target)) throw new ToolError("candidate is the target board", "invalid_args");
  const cli = await ctx.services.kicad.resolveCli();
  if (!cli) throw new ToolError("no kicad-cli found (Settings → KiCad CLI)", "unavailable");
  const route = ctx.services.routeRuns.latest(project.id);
  if (route && ["queued", "running", "cancel_requested", "cancelling"].includes(route.state))
    throw new ToolError("adopt refused: routing is active; wait for it to finish", "precondition");
  // which design files the candidate changes, and whether the project still holds what the change started from
  const origin = await candidateOrigin(candidate);
  const sheets: string[] = [];
  if (origin && resolve(origin.project) === resolve(project.dir)) {
    const now = await designFileHashes(project.dir);
    const cand = await designFileHashes(dirname(candidate));
    const stale = Object.keys(origin.files).filter((n) => now[n] !== origin.files[n] && cand[n] !== now[n]);
    if (stale.length)
      throw new ToolError(`adopt refused: ${stale.join(", ")} changed in the project since this candidate was computed; compute it again`, "precondition");
    for (const [n, h] of Object.entries(cand)) if (now[n] !== h) sheets.push(n);
  }
  ctx.progress(0.05, "retaining checkpoint");
  // the board timeline (board history in the app) gets the step: the board before, then the adopted one
  const pcbRel = relative(project.dir, target);
  await saveBoardPoint(project, pcbRel, "Before adopt").catch(() => null);
  const checkpoint = await retainTaskCheckpoint(
    project,
    { name: `before-adopt-${Date.now()}`, reason: `before adopting ${candidate}: ${input.reason}`, role: "checkpoint" },
    ctx.services.runtimeId,
  );
  ctx.progress(0.2, sheets.length ? `writing ${sheets.length} design file(s), then the board as one KiCad commit` : "applying candidate as one KiCad commit");
  const job = await governor().admit({ cls: "light", label: "adopt", paths: [project.dir], signal: ctx.signal, onWait: (w) => ctx.progress(0.2, w) });
  try {
    const keep = join(project.dir, ".fabdesk", "board", "adopt", stamp(), "before");
    const apply = async () => {
      if (sheets.length) await mkdir(keep, { recursive: true });
      for (const n of sheets) {
        const dst = join(project.dir, n);
        if (await stat(dst).catch(() => null)) await copyFile(dst, join(keep, n));
        await copyFile(join(dirname(candidate), n), dst);
      }
      return adopter.adopt({ target, candidate, cli, signal: ctx.signal });
    };
    const recovery = ctx.services.design.withSavedFilesRecovery;
    const result = recovery ? await recovery(project.dir, apply) : await apply();
    const clean = !Object.values(result.residual).some((m) => Object.keys(m).length);
    const point = await saveBoardPoint(project, pcbRel, `Adopted: ${input.reason}`.slice(0, 120)).catch(() => null);
    const fmt = (m: Record<string, number>) =>
      Object.entries(m).map(([k, n]) => `${k.replace("KOT_PCB_", "").toLowerCase()} ${n}`).join(", ") || "none";
    const text = [
      `${clean ? "Adopted" : "Adopted with residual differences"}: ${relative(project.dir, target)} ← ${candidate}`,
      `removed ${fmt(result.delta.removed)}; added ${fmt(result.delta.added)}; changed ${fmt(result.delta.changed)}`,
      ...(sheets.length ? [`design files written: ${sheets.join(", ")} (previous copies: ${relative(project.dir, keep)})`] : []),
      `residual ${clean ? "none" : JSON.stringify(result.residual)}; checkpoint ${checkpoint.id}${point ? `; board timeline point ${point.ref.slice(0, 12)}` : ""}`,
    ].join("\n");
    return { text, data: { ...result, checkpointId: checkpoint.id, target, clean, designFiles: sheets, timelinePoint: point?.ref ?? null }, clean };
  } finally {
    job.release();
  }
}
