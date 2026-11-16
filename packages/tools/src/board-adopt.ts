/**
 * Adopt a board candidate (made by an edit, last-mile or review stage in a scratch folder) into the project.
 * Checkpoint, then the schematic sheets, project libraries and requirements the candidate changed (only while the project's copy is
 * still the one the candidate was computed from), then the PCB delta as one KiCad commit over IPC, read back.
 */
import { copyFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { edit } from "@fabdesk/board-workflow";
import { jailPath } from "./fs";
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

/** Source revision plus the design and requirement files a candidate may carry. */
export const designFileHashes = edit.designFileHashes;

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

/**
 * Put every file `before` lists back as it was (a file that did not exist is removed) and say so: the error to throw
 * after a failed adopt. When a restore fails, the message names each file that still differs and where its copy is.
 */
async function rolledBack(e: unknown, before: Array<{ name: string; dst: string; sha: string | null }>, keep: string, projectDir: string): Promise<ToolError> {
  const why = e instanceof Error ? e.message : String(e);
  const differs: string[] = [];
  for (const b of before) {
    if ((await sha256File(b.dst)) === b.sha) continue;
    try {
      if (b.sha) await copyFile(join(keep, b.name), b.dst);
      else await rm(b.dst, { force: true });
    } catch {
      /* checked below */
    }
    if ((await sha256File(b.dst)) !== b.sha) differs.push(b.sha ? `${b.name} (previous copy: ${relative(projectDir, join(keep, b.name))})` : `${b.name} (did not exist before; remove it)`);
  }
  const code = e instanceof ToolError ? e.code : "internal";
  if (!differs.length)
    return new ToolError(`adopt failed: ${why}. The project was restored: the board and design files are as they were before the adopt (copies kept in ${relative(projectDir, keep)}).`, code);
  return new ToolError(`adopt failed: ${why}. Restoring the project also failed; these files differ from before the adopt: ${differs.join("; ")}. Copy them back before continuing.`, code);
}

export type AdoptOutcome = {
  text: string;
  data: BoardAdoptResult & { checkpointId: string; target: string; clean: boolean; designFiles: string[]; timelinePoint: string | null };
  clean: boolean;
};

/**
 * `board` is the project-relative board the stage worked on (the located `pcb`, the bench's board): required, so a
 * candidate computed from `panel.kicad_pcb` can never be applied onto `board.kicad_pcb`.
 */
export async function adoptCandidate(ctx: ToolContext, input: { candidate: string; board: string; reason: string }): Promise<AdoptOutcome> {
  const project = ctx.requireProject();
  const adopter = ctx.services.boardAdopt;
  if (!adopter) throw new ToolError("adopting a candidate board is unavailable in this runtime", "unavailable");
  const { candidate } = input;
  if (!candidate.endsWith(".kicad_pcb")) throw new ToolError("candidate must be a .kicad_pcb", "invalid_args");
  if (!(await stat(candidate).catch(() => null))?.isFile()) throw new ToolError(`candidate not found: ${candidate}`, "not_found");
  const target = await jailPath(project.dir, input.board);
  if (!target.endsWith(".kicad_pcb") || !(await stat(target).catch(() => null))?.isFile())
    throw new ToolError(`target board not found in the project: ${input.board}`, "not_found");
  if (resolve(candidate) === resolve(target)) throw new ToolError("candidate is the target board", "invalid_args");
  const cli = await ctx.services.kicad.resolveCli();
  if (!cli) throw new ToolError("no kicad-cli found (Settings → KiCad CLI)", "unavailable");
  const route = ctx.services.routeRuns.latest(project.id);
  if (route && ["queued", "running", "cancel_requested", "cancelling"].includes(route.state))
    throw new ToolError("adopt refused: routing is active; wait for it to finish", "precondition");
  const origin = await candidateOrigin(candidate);
  const pcbRel = relative(project.dir, target);
  const sheets: string[] = [];
  const matchingOrigin = origin && resolve(origin.project) === resolve(project.dir) ? origin : null;
  const checkSourceBoard = async () => {
    if (matchingOrigin && (!matchingOrigin.files[pcbRel] || await sha256File(target) !== matchingOrigin.files[pcbRel]))
      throw new ToolError(`adopt refused: ${pcbRel} changed in the project since this candidate was computed (or its source revision is missing); compute it again`, "precondition");
  };
  const checkDesign = async () => {
    sheets.length = 0;
    if (!matchingOrigin) return;
    const now = await designFileHashes(project.dir);
    const cand = await designFileHashes(dirname(candidate));
    const names = Object.keys(cand).filter((n) => !n.endsWith(".kicad_pcb"));
    const stale = [...new Set([...Object.keys(matchingOrigin.files), ...names])]
      .filter((n) => !n.endsWith(".kicad_pcb") && now[n] !== matchingOrigin.files[n] && cand[n] !== now[n]);
    if (stale.length)
      throw new ToolError(`adopt refused: ${stale.join(", ")} changed in the project since this candidate was computed; compute it again`, "precondition");
    for (const n of names) if (now[n] !== cand[n]) sheets.push(n);
  };
  await checkSourceBoard();
  await checkDesign();
  ctx.progress(0.05, "retaining checkpoint");
  // the board timeline (board history in the app) gets the step: the board before, then the adopted one
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
    // all or nothing: the board and every design file are copied aside first; any failure after the first write puts
    // them back, so the project never keeps new sheets beside the old board (or the reverse)
    const apply = async () => {
      // Recheck after admission and saved-file recovery, which can both wait.
      await checkSourceBoard();
      await checkDesign();
      await mkdir(keep, { recursive: true });
      const before: Array<{ name: string; dst: string; sha: string | null }> = [{ name: pcbRel, dst: target, sha: await sha256File(target) }];
      for (const n of sheets) before.push({ name: n, dst: join(project.dir, n), sha: await sha256File(join(project.dir, n)) });
      for (const b of before) if (b.sha) {
        await mkdir(dirname(join(keep, b.name)), { recursive: true });
        await copyFile(b.dst, join(keep, b.name));
      }
      let boardStarted = false;
      try {
        for (const n of sheets) {
          await mkdir(dirname(join(project.dir, n)), { recursive: true });
          await copyFile(join(dirname(candidate), n), join(project.dir, n));
        }
        await checkSourceBoard();
        boardStarted = true;
        return await adopter.adopt({ target, candidate, cli, signal: ctx.signal });
      } catch (e) {
        throw await rolledBack(e, boardStarted ? before : before.filter((b) => b.dst !== target), keep, project.dir);
      }
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
      ...(sheets.length ? [`design files written: ${sheets.join(", ")} (previous copies: ${relative(project.dir, keep)})`] : [`previous board: ${relative(project.dir, keep)}`]),
      `residual ${clean ? "none" : JSON.stringify(result.residual)}; checkpoint ${checkpoint.id}${point ? `; board timeline point ${point.ref.slice(0, 12)}` : ""}`,
    ].join("\n");
    return { text, data: { ...result, checkpointId: checkpoint.id, target, clean, designFiles: sheets, timelinePoint: point?.ref ?? null }, clean };
  } finally {
    job.release();
  }
}
