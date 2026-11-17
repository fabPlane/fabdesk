import { createHash } from "node:crypto";
import { parseBoard } from "./board";
import type { FindingRecord, ReviewRecord } from "./review/types";
/** Stage currency rules. Reviews/releases cover the full review design (including requirements).
 * BOM evidence covers PCB bytes only: placements and fitted parts are board-derived.
 * A saved gate additionally covers dispositions, intent and the imported review record.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep, isAbsolute } from "node:path";
import { readJsonOrNull, locateProject } from "./files";
import { savedBoard, matchesSavedBoard, countedSummary } from "./history";
import { reviewHash } from "./review/context";
import { currentReviewHash, reviewBasis, type ReviewBasis } from "./review/store";

export type Currency = "none" | "stale" | "current";
export const designCurrency = (covered: string | null | undefined, now: string | null): Currency =>
  !covered ? "none" : covered === now ? "current" : "stale";

export function reviewCurrency(hash: string, now: string, covered: string | undefined, pcb: string): string {
  if (hash !== now) return `stale: design ${now.slice(0, 8)} != reviewed ${hash.slice(0, 8)}`;
  if (covered !== pcb) return `stale: reviewed board ${covered ?? "(unspecified)"}, not ${pcb}`;
  return "current";
}
export type SavedGate = { state: "none" | "stale" | "open" | "errors" | "pass"; open?: number; mustFix?: number; at?: string; pcb?: string; designHash?: string | null; basis?: ReviewBasis };
export async function stageReviewGate(dir: string, pcb?: string): Promise<SavedGate> {
  const d = await readJsonOrNull<SavedGate>(join(dir, ".fabdesk/board/review-gate.json"));
  if (!d?.state) return { state: "none" };
  const now = await reviewBasis(dir);
  const keys = ["design", "dispositions", "intent", "run", "pcb"] as const;
  let stale = !d.basis?.design || keys.some(k => (d.basis?.[k] ?? null) !== now[k]);
  const want = pcb ? relative(dir, isAbsolute(pcb) ? pcb : join(dir, pcb)).split(sep).join("/") : await locateProject(dir).then(f => relative(dir, f.pcb).split(sep).join("/"), () => null);
  if (d.basis?.pcb && want && d.basis.pcb !== want) stale = true;
  return { ...d, state: stale ? "stale" : d.state };
}
export async function readIndependentReview(dir: string): Promise<{ hash: string; files?: Record<string, string>; findings: FindingRecord[] } | null> {
  const saved = await readJsonOrNull<{ hash: string; files?: Record<string, string>; findings: FindingRecord[] }>(join(dir, ".fabdesk/board/review/independent.json"));
  if (saved) return saved;
  // Older imports lived only in their run. Preserve that provenance when the next review carries it forward.
  const latest = await readJsonOrNull<{ run: string }>(join(dir, ".fabdesk/board/review/latest.json"));
  const r = latest ? await readJsonOrNull<ReviewRecord>(join(dir, ".fabdesk/board/review/runs", latest.run, "review.json")) : null;
  return r?.checks.some(c => c.name === "expert" && c.status === "ok") ? { hash: r.hash, files: r.files, findings: r.findings.filter(f => f.check === "expert") } : null;
}

export async function stageState(dir: string, pcb?: string) {
  const hash = await currentReviewHash(dir).catch(() => null);
  const gate = await stageReviewGate(dir, pcb);
  const latest = await readJsonOrNull<{ run: string }>(join(dir, ".fabdesk/board/review/latest.json"));
  const review = latest ? await readJsonOrNull<{ hash: string; files?: Record<string, string>; pcb?: string }>(join(dir, ".fabdesk/board/review/runs", latest.run, "review.json")) : null;
  const reviewedBoard = await locateProject(dir, pcb).then(f => relative(dir, f.pcb).split(sep).join("/"), () => "");
  const names = (await readdir(join(dir, "exports")).catch(() => [] as string[])).filter(n => n.startsWith("release-")).sort();
  const pkg = names.at(-1);
  const rel = pkg ? await readJsonOrNull<{ reviewDesignHash?: string; designHash?: string }>(join(dir, "exports", pkg, "acceptance-gate.json")) : null;
  const last = await readJsonOrNull<{ designHash?: string; out: string }>(join(dir, ".fabdesk/board/release/last-fab.json"));
  const expert = await readIndependentReview(dir);
  const dispositions = await readJsonOrNull<Record<string, { by?: string; state?: string; reason?: string }>>(join(dir, ".fabdesk/board/review/dispositions.json"));
  const deferred = Object.entries(dispositions ?? {}).some(([id, d]) => ["L8:EXPERT:-:-:pending", "L8:EXPERT:-:-:earlier"].includes(id) && d.by === "owner" && d.state === "defer" && !!d.reason?.trim());
  const cfg = await readJsonOrNull<Record<string, never>>(join(dir, ".fabdesk/board/review/config.json")) ?? {};
  const currentFiles = await reviewHash({ dir, cfg }).then(r => r.files, () => ({} as Record<string, string>));
  const changed = (files?: Record<string, string>) => [...new Set([...Object.keys(files ?? {}), ...Object.keys(currentFiles)])].filter(k => files?.[k] !== currentFiles[k]);
  const entries = await readJsonOrNull<Array<{ sha256?: string; designHash?: string; summary?: Record<string, boolean>; parityChecked?: boolean; figures?: Record<string, number>; results?: Array<{ code: string; figures: Record<string, unknown> }> }>>(join(dir, ".fabdesk/board/accept/index.json")) ?? [];
  const saved = await savedBoard(dir, pcb);
  const checks = [...entries].reverse().find(e => matchesSavedBoard(e, saved));
  const summary = checks ? countedSummary(checks) : {};
  const acceptancePass = Array.from({ length: 9 }, (_, i) => `A${i + 1}`).every(k => summary[k] === true);
  const openFigure = checks?.figures?.A1 ?? checks?.results?.find(r => r.code === "A1")?.figures.unconnected;
  const opens = typeof openFigure === "number" && Number.isFinite(openFigure) && openFigure >= 0 ? openFigure : null;
  const placed = reviewedBoard ? await readFile(join(dir, reviewedBoard), "utf8").then(t => parseBoard(t).footprints.size > 0, () => false).catch(() => false) : false;
  const published = await readJsonOrNull<{ designHash: string; checksPass: boolean; artifacts: Array<{ path: string; sha256: string }> }>(join(dir, "reports/board-completion.json"));
  let previewsCurrent = published?.designHash === hash && published.checksPass === true && Array.isArray(published.artifacts);
  if (previewsCurrent && published) {
    const paths = published.artifacts.map(a => a.path);
    previewsCurrent = ["renders/pcb.svg", "renders/board.glb", "reports/drc.json", "reports/erc.json"].every(p => paths.includes(p))
      && paths.some(p => p.startsWith("renders/") && p.endsWith(".svg") && p !== "renders/pcb.svg");
    for (const a of published.artifacts) {
      if (isAbsolute(a.path) || a.path.split(/[\\/]/).includes("..")) { previewsCurrent = false; break; }
      const bytes = await readFile(join(dir, a.path)).catch(() => null);
      if (!bytes || createHash("sha256").update(bytes).digest("hex") !== a.sha256) { previewsCurrent = false; break; }
    }
  }
  const boardStatus = !checks ? "checks missing or stale" : opens !== null && opens > 0 ? `${opens} opens remain`
    : !placed ? "placement missing or unverified" : !acceptancePass ? "acceptance checks failing"
    : !previewsCurrent ? "previews missing or stale" : "complete";
  return {
    designHash: hash,
    // Tool evidence cannot establish that the owner's requested scope has been met.
    task: { state: "change saved; request scope determines task completion", checks: checks ? acceptancePass ? "pass" : "failing" : "missing or stale" },
    board: { complete: boardStatus === "complete", status: boardStatus, opens },
    review: { state: !review ? "none" as const : reviewCurrency(review.hash, hash ?? "", review.pcb, reviewedBoard) === "current" && gate.state !== "stale" ? "current" as const : "stale" as const, coveredDesign: review?.hash ?? null, changedSince: changed(review?.files), gate },
    release: { state: (last || pkg) ? designCurrency(last?.designHash ?? rel?.reviewDesignHash ?? "legacy-unverified", hash) : "none" as Currency, package: last?.out ?? (pkg ? `exports/${pkg}` : null) },
    independent: { state: deferred ? "deferred" : !expert ? "missing" : expert.hash === hash ? "current" : "covers an earlier design", coveredDesign: expert?.hash ?? null, changedSince: changed(expert?.files) },
  };
}
export async function savedStageLine(dir: string, pcb?: string): Promise<string> {
  const s = await stageState(dir, pcb);
  return `Task: change saved; task done means request scope met, its checks passing and previews published. Board: ${s.board.status}. Review: ${s.review.state === "current" ? "current" : "stale since this change"}. Release: ${s.release.state === "current" ? "current" : "stale"}. Recommended next: board_review run (the owner decides).`;
}

/** PCB-only BOM receipts deliberately remain current across schematic edits; the review never does. */
export const bomCurrency = (recordedBoardSha: string | null, currentBoardSha: string | null): Currency =>
  designCurrency(recordedBoardSha, currentBoardSha);
