/**
 * The autopilot after layout (the toolkit's `pcb run`): review if stale -> the workflow's fixes (settle what intent and
 * evidence decide, build and prove an edit candidate per edit proposal, the combined candidate, a change picture per
 * READY candidate) -> only the owner's questions. On a low disk it says so first and builds no candidate copies.
 */
import { statfs } from "node:fs/promises";
import type { ReviewEnv, ReviewProject } from "./context";
import { fixProposals, reviewGate, runReview, type EditCandidateBuilder, type FixResult, type GateResult } from "./review";
import { loadCurrent } from "./store";
import { reviewHash } from "./context";

/** None when the disk under `path` is healthy, else the one line (solution first) the autopilot prints. */
export async function lowDisk(path: string, minFreeGiB = 10, minFreePct = 10): Promise<string | null> {
  const s = await statfs(path).catch(() => null);
  if (!s || !s.blocks) return null;
  const free = (s.bavail * s.bsize) / 2 ** 30;
  const pct = (100 * s.bavail) / s.blocks;
  if (free >= minFreeGiB && pct >= minFreePct) return null;
  return `disk low: ${free.toFixed(1)} GiB free (${pct.toFixed(0)} %): no candidate copies are built; board_route prune and removing old .fabdesk/board/edits candidates free space`;
}

export interface AutopilotOptions {
  offline?: boolean;
  builder?: EditCandidateBuilder;
  /** A low-disk note (see `lowDisk`): settle only, build nothing heavy. */
  lowDisk?: string | null;
  progress?: (note: string) => void;
  /** Admission for the review run (the host's resource governor); released when the review is written. */
  admit?: () => Promise<{ release(): void }>;
}

export interface AutopilotResult {
  /** The review run this call made (null: the latest review was current). */
  reviewed: { dir: string; findings: number; open: number } | null;
  fix: FixResult;
  gate: GateResult;
  /** The owner's questions (finding ids), all that is left for the owner. */
  owner: string[];
  lines: string[];
}

export async function autopilot(project: ReviewProject, env: ReviewEnv, opts: AutopilotOptions = {}): Promise<AutopilotResult> {
  const lines: string[] = [];
  if (opts.lowDisk) lines.push(`[0/3] ${opts.lowDisk}`);
  const cur = await loadCurrent(project);
  let reviewed: AutopilotResult["reviewed"] = null;
  if (cur.state !== "current") {
    const { hash } = await reviewHash(project);
    lines.push(`[1/3] review ${project.name} (design ${hash.slice(0, 12)}; ${cur.state})`);
    const job = await opts.admit?.();
    let r: Awaited<ReturnType<typeof runReview>>;
    try {
      r = await runReview(project, env, { offline: !!opts.offline, ...(opts.progress ? { progress: opts.progress } : {}) });
    } finally {
      job?.release();
    }
    reviewed = { dir: r.dir, findings: r.review.findings.length, open: r.evaluation.open.length };
    lines.push(`   ${r.review.findings.length} findings, ${r.evaluation.open.length} open, ${r.evaluation.errors.length} check errors -> ${r.dir}`);
  } else lines.push(`[1/3] review current (${cur.review!.hash.slice(0, 12)})`);
  lines.push("[2/3] workflow fixes: settle what intent/evidence decides, build and prove edit candidates");
  const fix = await fixProposals(project, { apply: true, ...(opts.builder ? { builder: opts.builder } : {}), build: !opts.lowDisk, quiet: true });
  for (const l of fix.lines) {
    const t = l.trim();
    if (/^(settled|candidate|COMBINED|change picture|edit proposal|\/)/.test(t)) lines.push(...l.split("\n").map((x) => "   " + x.trim()));
  }
  lines.push("[3/3] what is left");
  const gate = await reviewGate(project);
  lines.push(`   ${gate.lines[0] ?? ""}`);
  const k = gate.classified;
  if (gate.exit === 3) lines.push(...gate.lines.slice(1).map((l) => "   " + l));
  else lines.push(`   agent tasks: ${k?.task.length ?? 0}; fixed in the READY candidate: ${k?.candidate.length ?? 0} (board_review fix lists them)`);
  const ownerLines = gate.lines.filter((l) => l.startsWith("- NEEDS OWNER"));
  for (const l of ownerLines) lines.push("   " + l.slice(2));
  if (!ownerLines.length && gate.exit !== 3) lines.push("   nothing needs the owner");
  return { reviewed, fix, gate, owner: k?.owner ?? [], lines };
}
