/** The board's A1-A9 acceptance as the board workflow recorded it for the saved board (local only; never published). */
import { z } from "zod/v4";

/** The nine acceptance checks of the board workflow (A1..A9). */
export const AcceptCode = z.enum(["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]);
export type AcceptCode = z.infer<typeof AcceptCode>;
export const ACCEPT_CODES = AcceptCode.options;

/**
 * One check's result as `board_check` records it. `figures` are the numbers the verdict rests on (counts, minimum
 * clearances, lengths), `evidence` the human-readable lines that name the offending nets / refs / files.
 * `na` = the check does not apply to this board (for example no differential pairs), never a silent pass.
 */
export const AcceptResult = z.object({
  code: AcceptCode,
  status: z.enum(["pass", "fail", "na", "error"]),
  figures: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
  evidence: z.array(z.string()).default([]),
});
export type AcceptResult = z.infer<typeof AcceptResult>;

/** All results for one measurement of the saved board (`sha256` is the board file hash it was measured on). */
export const AcceptRecord = z.object({ at: z.string(), sha256: z.string(), results: z.array(AcceptResult) });
export type AcceptRecord = z.infer<typeof AcceptRecord>;

/** code -> passes. `na` counts as passing; `fail` and `error` do not. */
export function acceptSummary(results: ReadonlyArray<Pick<AcceptResult, "code" | "status">>): Record<string, boolean> {
  return Object.fromEntries(results.map((r) => [r.code, r.status === "pass" || r.status === "na"]));
}

export const BoardChecks = z.object({
  /** The project has used the board workflow (its folder or a recorded result exists). */
  used: z.boolean(),
  /** none: never measured; stale: measured on an earlier board; current: measured on the saved board. */
  state: z.enum(["none", "stale", "current"]),
  failing: z.array(z.string()),
  baselineFailing: z.array(z.string()),
  regressions: z.array(z.string()),
  /** Strict, or "no new failure" for a board that came in already failing checks. */
  mode: z.enum(["strict", "no-regression"]),
  at: z.string().optional(),
  /** Added later; optional so an older daemon's answer still parses. */
  history: z.array(z.object({ at: z.string(), failing: z.array(z.string()), pass: z.boolean(), current: z.boolean() })).optional(),
  candidates: z.array(z.object({ id: z.string(), verdict: z.string(), startedAt: z.string(), seconds: z.number(), collateralNets: z.number() })).optional(),
  review: z.object({ state: z.enum(["none", "stale", "open", "errors", "pass"]), open: z.number().optional(), mustFix: z.number().optional(), at: z.string().optional() }).optional(),
  onboarding: z.object({ toConfirm: z.number(), confirmed: z.boolean() }).nullable().optional(),
});
export type BoardChecks = z.infer<typeof BoardChecks>;

/** One line for the Status page; never claims manufacturing approval. */
export function boardChecksLabel(c: BoardChecks): string {
  if (c.state === "none") return "A1-A9 not measured yet";
  if (c.state === "stale") return "A1-A9 measured on an earlier board";
  if (c.failing.length === 0) return "A1-A9 pass";
  if (c.mode === "no-regression" && c.regressions.length === 0)
    return `No new failure; ${c.failing.length} check${c.failing.length === 1 ? "" : "s"} failed before the work (${c.failing.join(", ")})`;
  return c.regressions.length ? `A1-A9: newly failing ${c.regressions.join(", ")}` : `A1-A9 failing ${c.failing.join(", ")}`;
}

/** The review gate on one line. */
export function boardReviewLabel(r: NonNullable<BoardChecks["review"]>): string {
  if (r.state === "none") return "Review not run";
  if (r.state === "pass") return "Review: every finding settled";
  if (r.state === "stale") return "Review: stale, the board changed since";
  if (r.state === "errors") return "Review: check errors";
  return `Review: ${r.open ?? "?"} finding${r.open === 1 ? "" : "s"} open${r.mustFix ? ` (${r.mustFix} must-fix)` : ""}`;
}
