/**
 * Adopt a board candidate (made by an edit, last-mile or review stage in a scratch folder) into the project.
 * Checkpoint, then the schematic sheets, project libraries and requirements the candidate changed (only while the project's copy is
 * still the one the candidate was computed from), then the PCB delta as one KiCad commit over IPC, read back, then the
 * candidate's DRC exclusions (an edit re-keys the ones it made stale) into the project file.
 * A board saved by a newer KiCad than the PCB bridge's and the selected kicad-cli's is written as a file instead (see
 * `formatTooNew`), with the same checkpoint, copy-aside and restore.
 */
import { copyFile, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, relative, resolve } from "node:path";
import { jailPath, writeAtomic, writeJson } from "./fs";
import { tmpdir } from "node:os";
import { runLiveDrc } from "./tools/common";
import type { KicadCli, DrcReport } from "./services";
import { saveBoardPoint } from "./board-history";
import { governor } from "./resources";
import { ToolError, type ToolContext } from "./registry";
import type { BoardAdoptResult } from "./services";
import { retainTaskCheckpoint } from "./task-checkpoints";
import { childLists, edit, release, listSpanAt, parseSexpr } from "@fabdesk/board-workflow";

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
export async function candidateOrigin(candidatePcb: string): Promise<{
  project: string;
  files: Record<string, string>;
  extra?: Record<string, string | null>;
  /** The project's DRC exclusions when the candidate was computed (`file` project-relative, sha256 of `edit.exclusionsText`). */
  exclusions?: { file: string; sha256: string };
} | null> {
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
      if (b.sha) await writeAtomic(b.dst, await readFile(join(keep, b.name)));
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

/**
 * KiCad's refusal to load a board saved by a newer KiCad ("created with a more recent version than the one you are
 * running ... file format dated 20261025 or later"), from the PCB bridge or a kicad-cli: the reason in a few words, or
 * null for any other error (which adopt never works around).
 */
export function formatTooNew(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/created with a more recent version than the one you are running|file format dated \d{8} or later/i.test(msg)) return null;
  const v = /version ([\d.]+) or later \(file format dated (\d{8}) or later\)/i.exec(msg);
  return v ? `it needs KiCad ${v[1]} or later, file format ${v[2]}` : "it was saved by a newer KiCad";
}

const TYPE_OF: Record<string, string> = { footprint: "KOT_PCB_FOOTPRINT", segment: "KOT_PCB_TRACE", arc: "KOT_PCB_ARC", via: "KOT_PCB_VIA", zone: "KOT_PCB_ZONE", gr_text: "KOT_PCB_TEXT", group: "KOT_PCB_GROUP", dimension: "KOT_PCB_DIMENSION" };
/** Top-level items by uuid (type, whitespace-collapsed block): what a file write changed, counted as the IPC delta is. */
function itemsByUuid(text: string): Map<string, { type: string; block: string }> {
  const out = new Map<string, { type: string; block: string }>();
  const open = text.indexOf("(");
  if (open < 0) return out;
  for (const s of childLists(text, listSpanAt(text, open))) {
    const block = text.slice(s.start, s.end);
    const head = /^\(([A-Za-z_0-9]+)/.exec(block)?.[1] ?? "";
    const uuid = /\(uuid\s+"?([0-9a-fA-F-]{36})"?\)/.exec(block)?.[1];
    if (!uuid) continue;
    out.set(uuid, { type: TYPE_OF[head] ?? (head.startsWith("gr_") ? "KOT_PCB_SHAPE" : `KOT_PCB_${head.toUpperCase()}`), block: block.replace(/\s+/g, " ") });
  }
  return out;
}
function itemDelta(a: string, b: string): BoardAdoptResult["delta"] {
  const ia = itemsByUuid(a), ib = itemsByUuid(b);
  const d: BoardAdoptResult["delta"] = { removed: {}, added: {}, changed: {} };
  const bump = (m: Record<string, number>, t: string) => void (m[t] = (m[t] ?? 0) + 1);
  for (const [u, x] of ia) if (!ib.has(u)) bump(d.removed, x.type);
  for (const [u, x] of ib) {
    const old = ia.get(u);
    if (!old) bump(d.added, x.type);
    else if (old.block !== x.block) bump(d.changed, x.type);
  }
  return d;
}

/**
 * The candidate board written over the target as text, for a board no available KiCad can open (so no KiCad commit is
 * possible and no KiCad session can be holding it). Read back: sha256 equal to the candidate's, and it parses as a
 * `kicad_pcb`. A kicad-cli load check is not possible: the selected kicad-cli has just refused this file format.
 */
async function writeBoardFile(target: string, candidate: string, cli: { path: string }): Promise<BoardAdoptResult> {
  const t0 = performance.now();
  const was = await readFile(target, "utf8");
  const text = await readFile(candidate, "utf8");
  if (childLists(text, listSpanAt(text, text.indexOf("("))).some(span => /^\(zone\b/.test(text.slice(span.start, span.end))))
    throw new ToolError("This board has zones but no available KiCad can refill and save this format. Configure a compatible KiCad before adoption; the target was kept.", "precondition");
  await writeAtomic(target, text);
  const back = await readFile(target);
  const want = createHash("sha256").update(text).digest("hex");
  const got = createHash("sha256").update(back).digest("hex");
  if (got !== want) throw new ToolError(`the written board does not read back as the candidate (sha256 ${got.slice(0, 12)}, expected ${want.slice(0, 12)})`, "internal");
  let head: unknown;
  try {
    head = parseSexpr(back.toString("utf8"))[0];
  } catch (e) {
    throw new ToolError(`the written board does not parse: ${e instanceof Error ? e.message : String(e)}`, "internal");
  }
  if (head !== "kicad_pcb") throw new ToolError(`the written board is not a kicad_pcb (root ${String(head)})`, "internal");
  return {
    zoneRefill: { refilled: false },
    delta: itemDelta(was, text),
    residual: { removed: {}, added: {}, changed: {} },
    targetSha256Before: createHash("sha256").update(was).digest("hex"),
    targetSha256After: got,
    timingsMs: { write: Math.round(performance.now() - t0) },
    kicadCli: cli.path,
  };
}

export type CanonicalAdoptionDrc = {
  status: "measured" | "unavailable" | "stale";
  pcbSha256: string;
  pass: boolean;
  counts?: DrcReport["counts"];
  reason?: string;
};

/** Check the persisted target without refilling or borrowing a candidate's score. */
export async function checkCanonicalAdoption(ctx: ToolContext, target: string, cli: KicadCli): Promise<CanonicalAdoptionDrc> {
  const before = (await sha256File(target))!;
  const scratch = await mkdtemp(join(tmpdir(), "fabdesk-adopt-drc-"));
  try {
    const report = await runLiveDrc(ctx, cli, { board: target, outFile: join(scratch, "drc.json"), parity: false, refill: false, signal: ctx.signal });
    if (await sha256File(target) !== before) return { status: "stale", pcbSha256: before, pass: false, reason: "Saved target changed during post-adoption DRC" };
    const path = basename(target) === "board.kicad_pcb" ? "reports/drc.json" : `reports/${basename(target, ".kicad_pcb")}-drc.json`;
    await writeJson(await jailPath(ctx.requireProject().dir, path), { ...report, schematicParityChecked: false, pcbRevision: { sha256: before }, checkBasis: "canonical saved board after adoption; no refill" });
    return { status: "measured", pcbSha256: before, pass: report.counts.errors === 0 && report.counts.unconnected === 0, counts: report.counts };
  } catch (error) {
    return { status: "unavailable", pcbSha256: before, pass: false, reason: error instanceof Error ? error.message : String(error) };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

export type AdoptOutcome = {
  text: string;
  data: BoardAdoptResult & {
    canonicalDrc: CanonicalAdoptionDrc;
    checkpointId: string;
    target: string;
    clean: boolean;
    designFiles: string[];
    timelinePoint: string | null;
    /** "ipc": one KiCad commit; "file": the candidate's text written (the board's format is newer than any KiCad here). */
    via: "ipc" | "file";
    /** Why adopt did not take the usual path (bridge or kicad-cli could not open the board), when it did not. */
    viaNote: string | null;
    /** DRC exclusions written into the project file from the candidate (count), or null when they were left alone. */
    drcExclusions: number | null;
  };
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
  const cli = await ctx.services.kicad.resolveCli(ctx.signal);
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
    const names = Object.keys(cand).filter((n) => !n.endsWith(".kicad_pcb") && !n.endsWith(".kicad_pro"));
    const stale = [...new Set([...Object.keys(matchingOrigin.files), ...names])]
      .filter((n) => !n.endsWith(".kicad_pcb") && now[n] !== matchingOrigin.files[n] && cand[n] !== now[n]);
    if (stale.length)
      throw new ToolError(`adopt refused: ${stale.join(", ")} changed in the project since this candidate was computed; compute it again`, "precondition");
    for (const n of names) if (now[n] !== cand[n]) sheets.push(n);
    // other project files the candidate changed (an edit's library footprint, acceptance.json): only while the project
    // still holds what the candidate started from
    for (const [rel, h] of Object.entries(matchingOrigin.extra ?? {})) {
      const p = await jailPath(project.dir, rel);
      if ((await sha256File(p)) !== h) throw new ToolError(`adopt refused: ${rel} changed in the project since this candidate was computed; compute it again`, "precondition");
      if ((await sha256File(join(dirname(candidate), rel))) !== h && !sheets.some((n) => join(n) === join(rel))) sheets.push(rel);
    }
  };
  await checkSourceBoard();
  await checkDesign();
  // Attribute stamps from an engine are process changes, not manufacturing authorization.
  let previousVias: ReturnType<typeof release.classifyVias>, candidateVias: ReturnType<typeof release.classifyVias>;
  try { previousVias = release.classifyVias(await readFile(target,"utf8")); candidateVias = release.classifyVias(await readFile(candidate,"utf8")); }
  catch (error) { throw new ToolError(`Via manufacturing policy could not be verified: ${String(error)}. The canonical board was kept.`,"precondition"); }
  const identity = (v: typeof candidateVias[number]) => v.uuid ?? `${v.net}@${v.xy.join(",")}`;
  const old = new Map(previousVias.map(v => [identity(v), v]));
  // A via in the same pads on the same net counts as the one that was already there: a reroute that rips and recreates
  // it gives it a new uuid but adds nothing to the manufacturing process.
  const landsKey = (v: typeof candidateVias[number]) => `${v.net}|${v.in_component_lands.join(",")}`;
  const before = new Map<string, number>();
  for (const v of previousVias) if (v.in_component_lands.length) before.set(landsKey(v), (before.get(landsKey(v)) ?? 0) + 1);
  const inPad = candidateVias.filter(v => v.in_component_lands.length);
  const kept = new Set(inPad.filter(v => old.get(identity(v))?.in_component_lands.length));
  for (const v of kept) before.set(landsKey(v), Math.max(0, (before.get(landsKey(v)) ?? 0) - 1));
  const newInPad = inPad.filter(v => {
    if (kept.has(v)) return false;
    const left = before.get(landsKey(v)) ?? 0;
    if (left > 0) { before.set(landsKey(v), left - 1); return false; }
    return true;
  });
  const newProcess = candidateVias.filter(v =>
    v.native_filling && !old.get(identity(v))?.native_filling ||
    v.native_capping && !old.get(identity(v))?.native_capping);
  const acceptance = JSON.parse(await readFile(join(project.dir, ".fabdesk/board/requirements/acceptance.json"), "utf8").catch(() => "{}"));
  const allowed = (value: unknown) => typeof value === "object" && value !== null && (value as { allow?: boolean }).allow === true && typeof (value as { basis?: string }).basis === "string" && Boolean((value as { basis: string }).basis.trim());
  if (newInPad.length && !allowed(acceptance.manufacturing_rules?.via_in_pad))
    throw new ToolError(`Adoption refused: ${newInPad.length} new via(s) in solder pads. Move them out, or record a justified manufacturing_rules.via_in_pad {allow:true,basis} requirement before adoption.`, "precondition");
  if (newProcess.length && !allowed(acceptance.manufacturing_rules?.filled_capped_vias))
    throw new ToolError(`Adoption refused: ${newProcess.length} via(s) add filled/capped fabrication attributes. Record a justified manufacturing_rules.filled_capped_vias {allow:true,basis} requirement first.`, "precondition");
  // the candidate's DRC exclusions (an edit re-keys the ones it made stale): only that key of the project file, and only
  // while the project's exclusions are still the ones the candidate started from
  let exclusions: { path: string; rel: string; from: edit.Exclusion[]; entries: edit.Exclusion[] } | null = null;
  if (origin?.exclusions && resolve(origin.project) === resolve(project.dir)) {
    const name = basename(origin.exclusions.file);
    const projPro = join(dirname(target), name);
    const want = edit.readDrcExclusions((await readFile(join(dirname(candidate), name), "utf8").catch(() => "")) || "null");
    const haveText = await readFile(projPro, "utf8").catch(() => null);
    const have = haveText !== null ? edit.readDrcExclusions(haveText) : null;
    if (want && haveText !== null && edit.exclusionsText(want) !== edit.exclusionsText(have)) {
      if (createHash("sha256").update(edit.exclusionsText(have)).digest("hex") !== origin.exclusions.sha256)
        throw new ToolError(`adopt refused: the DRC exclusions in ${relative(project.dir, projPro)} changed in the project since this candidate was computed; compute it again`, "precondition");
      exclusions = { path: projPro, rel: relative(project.dir, projPro), from: have ?? [], entries: want };
    }
  }
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
    let stackupWritten = false;
    let fileWhy: string | null = null;
    // all or nothing: the board and every design file are copied aside first; any failure after the first write puts
    // them back, so the project never keeps new sheets beside the old board (or the reverse)
    const apply = async () => {
      // Recheck after admission and saved-file recovery, which can both wait.
      await checkSourceBoard();
      await checkDesign();
      await mkdir(keep, { recursive: true });
      const before: Array<{ name: string; dst: string; sha: string | null }> = [{ name: pcbRel, dst: target, sha: await sha256File(target) }];
      for (const n of sheets) before.push({ name: n, dst: join(project.dir, n), sha: await sha256File(join(project.dir, n)) });
      if (exclusions) before.push({ name: exclusions.rel, dst: exclusions.path, sha: await sha256File(exclusions.path) });
      for (const b of before) if (b.sha) {
        await mkdir(dirname(join(keep, b.name)), { recursive: true });
        await copyFile(b.dst, join(keep, b.name));
      }
      let boardStarted = false;
      try {
        for (const n of sheets) {
          await mkdir(dirname(join(project.dir, n)), { recursive: true });
          await writeAtomic(join(project.dir, n), await readFile(join(dirname(candidate), n)));
        }
        await checkSourceBoard();
        boardStarted = true;
        let res: BoardAdoptResult;
        try {
          res = await adopter.adopt({ target, candidate, cli, signal: ctx.signal });
        } catch (e) {
          // the selected kicad-cli cannot open the board either: no KiCad here can, so none can hold it open, and the
          // candidate's text goes in as a file (any other failure is not worked around)
          const why = formatTooNew(e);
          if (!why) throw e;
          fileWhy = `kicad-cli ${cli.path} (${cli.version || "version unknown"}) cannot open this board: ${why}`;
          res = await writeBoardFile(target, candidate, cli);
        }
        // the stackup (dielectrics) is board setup, not an item: the IPC delta cannot carry it, so it is written as text
        // (a file write carried the whole candidate, stackup included)
        const want = fileWhy ? null : edit.stackupText(await readFile(candidate, "utf8"));
        const have = await readFile(target, "utf8");
        const cur = edit.stackupText(have);
        if (want !== null && cur !== null && want.replace(/\s+/g, " ") !== cur.replace(/\s+/g, " ")) {
          await writeAtomic(target, edit.withStackup(have, want));
          stackupWritten = true;
        }
        // after the commit and save: KiCad's save may write the project file too (KiCad 10.99 re-stores every exclusion in
        // its v3 form), so the edit's change is applied to the file as it is now, in the form it now uses
        if (exclusions) await writeAtomic(exclusions.path, edit.withExclusionChanges(await readFile(exclusions.path, "utf8"), exclusions.from, exclusions.entries));
        return res;
      } catch (e) {
        throw await rolledBack(e, boardStarted ? before : before.filter((b) => b.dst !== target), keep, project.dir);
      }
    };
    // the PCB bridge first closes any live session on the project (refusing over unsaved work); a bridge whose KiCad cannot
    // load the board (saved by a newer KiCad) has none on it, so the adopt goes on with the selected kicad-cli
    const recovery = ctx.services.design.withSavedFilesRecovery;
    let started = false;
    const run = () => ((started = true), apply());
    let bridgeWhy: string | null = null;
    let result: BoardAdoptResult;
    try {
      result = recovery ? await recovery(project.dir, run) : await run();
    } catch (e) {
      const why = formatTooNew(e);
      if (!recovery || started || !why) throw e;
      bridgeWhy = `the PCB bridge's KiCad cannot open this board (${why}), so no live KiCad session holds it`;
      result = await run();
    }
    const canonicalDrc = await checkCanonicalAdoption(ctx, target, cli);
    result.targetSha256After = (await sha256File(target))!;
    const viaNote = [bridgeWhy, fileWhy].filter(Boolean).join("; ") || null;
    const clean = !Object.values(result.residual).some((m) => Object.keys(m).length);
    const point = await saveBoardPoint(project, pcbRel, `Adopted: ${input.reason}`.slice(0, 120)).catch(() => null);
    const fmt = (m: Record<string, number>) =>
      Object.entries(m).map(([k, n]) => `${k.replace("KOT_PCB_", "").toLowerCase()} ${n}`).join(", ") || "none";
    const text = [
      `${canonicalDrc.status !== "measured" ? "Adopted (saved board not verified)" : !canonicalDrc.pass ? (canonicalDrc.counts?.errors ? "Adopted with DRC errors on the saved board" : "Adopted with open connections on the saved board") : clean ? "Adopted" : "Adopted with residual differences"}: ${relative(project.dir, target)} ← ${candidate}`,
      ...(fileWhy
        ? [`written as a file, not as a KiCad commit: ${viaNote}. Read back: sha256 equal to the candidate's and it parses as a kicad_pcb; no KiCad load check is possible here (configure a kicad-cli that opens this format in Settings → KiCad CLI for one)`]
        : bridgeWhy
          ? [`${bridgeWhy}; applied as one KiCad commit with kicad-cli ${cli.path}`]
          : []),
      `Zone refill before save: ${result.zoneRefill?.refilled ? "completed" : result.zoneRefill ? "no zones refilled" : "unverified by adapter"}.`,
      canonicalDrc.counts ? `Saved-board DRC: ${canonicalDrc.counts.errors} errors, ${canonicalDrc.counts.unconnected} open, ${canonicalDrc.counts.warnings} warnings (no refill; PCB ${canonicalDrc.pcbSha256.slice(0, 12)}).` : `Saved-board DRC ${canonicalDrc.status}: ${canonicalDrc.reason}. Adoption is unverified.`,
      `removed ${fmt(result.delta.removed)}; added ${fmt(result.delta.added)}; changed ${fmt(result.delta.changed)}`,
      ...(sheets.length ? [`design files written: ${sheets.join(", ")} (previous copies: ${relative(project.dir, keep)})`] : [`previous board: ${relative(project.dir, keep)}`]),
      ...(stackupWritten ? ["stackup written from the candidate (board setup; the KiCad commit carries items only)"] : []),
      ...(exclusions ? [`DRC exclusions written to ${exclusions.rel} from the candidate (that key only; ${exclusions.entries.length} entries, ${exclusions.entries.filter((w) => !exclusions!.from.some((h) => h.key === w.key && h.comment === w.comment)).length} new or re-keyed)`] : []),
      `residual ${clean ? "none" : JSON.stringify(result.residual)}; checkpoint ${checkpoint.id}${point ? `; board timeline point ${point.ref.slice(0, 12)}` : ""}`,
    ].join("\n");
    return {
      text,
      data: { ...result, canonicalDrc, checkpointId: checkpoint.id, target, clean, designFiles: sheets, timelinePoint: point?.ref ?? null, via: fileWhy ? "file" : "ipc", viaNote, drcExclusions: exclusions ? exclusions.entries.length : null },
      clean,
    };
  } finally {
    job.release();
  }
}

/**
 * Replace the project's board file with `candidate` as a file write, for a change KiCad's item delta cannot carry (a file
 * format upgrade: the items are the same, so an IPC adopt would save nothing). Same safeguards as `adoptCandidate`:
 * routing must be idle, a checkpoint and a board timeline point first, the previous board copied to
 * `.fabdesk/board/adopt/<stamp>/before/`, restored if the write fails.
 */
export async function replaceBoardFile(ctx: ToolContext, input: { candidate: string; board: string; reason: string }): Promise<{ text: string; keep: string; checkpointId: string; timelinePoint: string | null }> {
  const project = ctx.requireProject();
  const target = await jailPath(project.dir, input.board);
  if (!target.endsWith(".kicad_pcb") || !(await stat(target).catch(() => null))?.isFile()) throw new ToolError(`target board not found in the project: ${input.board}`, "not_found");
  if (!(await stat(input.candidate).catch(() => null))?.isFile()) throw new ToolError(`candidate not found: ${input.candidate}`, "not_found");
  const route = ctx.services.routeRuns.latest(project.id);
  if (route && ["queued", "running", "cancel_requested", "cancelling"].includes(route.state)) throw new ToolError("refused: routing is active; wait for it to finish", "precondition");
  const pcbRel = relative(project.dir, target);
  await saveBoardPoint(project, pcbRel, "Before board file replace").catch(() => null);
  const checkpoint = await retainTaskCheckpoint(project, { name: `before-replace-${Date.now()}`, reason: `before replacing ${pcbRel}: ${input.reason}`, role: "checkpoint" }, ctx.services.runtimeId);
  const job = await governor().admit({ cls: "light", label: "board file replace", paths: [project.dir], signal: ctx.signal, onWait: (w) => ctx.progress(0.2, w) });
  try {
    const keep = join(project.dir, ".fabdesk", "board", "adopt", stamp(), "before");
    const apply = async () => {
      await mkdir(dirname(join(keep, pcbRel)), { recursive: true });
      await copyFile(target, join(keep, pcbRel));
      try {
        await writeAtomic(target, await readFile(input.candidate));
      } catch (e) {
        await copyFile(join(keep, pcbRel), target).catch(() => null);
        throw e;
      }
    };
    const recovery = ctx.services.design.withSavedFilesRecovery;
    if (recovery) await recovery(project.dir, apply);
    else await apply();
    const point = await saveBoardPoint(project, pcbRel, `Replaced: ${input.reason}`.slice(0, 120)).catch(() => null);
    const text = `Wrote ${pcbRel} (${input.reason}); previous board: ${relative(project.dir, join(keep, pcbRel))}; checkpoint ${checkpoint.id}${point ? `; board timeline point ${point.ref.slice(0, 12)}` : ""}`;
    return { text, keep: join(keep, pcbRel), checkpointId: checkpoint.id, timelinePoint: point?.ref ?? null };
  } finally {
    job.release();
  }
}
