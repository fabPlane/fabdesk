/**
 * Where the board stands in the workflow and the one next step, after a `board_check` run (the toolkit's `pcb status`:
 * onboarding, review, release in one view plus the next command). Read-only: it reads the onboarding confirmation, the
 * latest review against this design and the newest release package's acceptance gate.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { openReviewProject, reviewStatus, type AcceptCode, type AcceptRun } from "@fabdesk/board-workflow";
import { readOnboardingCheck } from "../board-state";

/** What fixes a failing check, by stage tool. */
const FIX: Record<AcceptCode, string> = {
  A1: 'board_route last mile: {"action":"new"} then {"action":"try","actions":["finish","rip"]}',
  A2: 'board_route {"action":"try","actions":["shorts"]} for copper errors; board_edit for placement (courtyards)',
  A3: "board_edit (or pcb_update_from_schematic) so board and schematic agree",
  A4: "board_edit: the circuit differs from the onboarded snapshot; check the change was intended (onboard refresh if it was)",
  A5: "board_edit move: a fixed part left its anchor",
  A6: 'board_route {"action":"try"} on the plane / via-span findings',
  A7: 'board_route {"action":"try","actions":["a7"]}',
  A8: 'board_route {"action":"pairs"} then {"action":"try","actions":["pairs"]} or tighten/reroute per pair',
  A9: "board_edit swap (a lower part) or an owner height decision",
};

export interface WorkflowStatus {
  onboarding: { confirmed: boolean } | null;
  review: { state: string; open: number; mustFix: number } | null;
  release: { package: string; current: boolean } | null;
  next: string;
}

async function newestRelease(projectDir: string): Promise<{ package: string; designHash: string | null } | null> {
  const dir = join(projectDir, "exports");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith("release-")).sort();
  const name = names.at(-1);
  if (!name) return null;
  const gate = JSON.parse(await readFile(join(dir, name, "acceptance-gate.json"), "utf8").catch(() => "{}")) as { designHash?: string };
  return { package: `exports/${name}`, designHash: gate.designHash ?? null };
}

export async function workflowStatus(projectDir: string, run: AcceptRun, pcb?: string): Promise<WorkflowStatus> {
  const ob = await readOnboardingCheck(projectDir).catch(() => undefined);
  const rv = await openReviewProject(projectDir, pcb)
    .then((p) => reviewStatus(p))
    .catch(() => null);
  const rel = await newestRelease(projectDir);
  const failing = (Object.entries(run.entry.summary) as Array<[AcceptCode, boolean]>).filter(([, v]) => !v).map(([k]) => k);
  const regressed = run.baseline?.newFailures ?? [];
  const reviewCurrent = rv?.state === "current";
  const releaseCurrent = !!rel && rel.designHash === run.entry.designHash;
  let next: string;
  if (failing.includes("A1")) next = `close the open connections: ${FIX.A1}`;
  else if (regressed.length) next = `fix what got worse since onboarding (${regressed.join(", ")}): ${regressed.map((c) => `${c}: ${FIX[c]}`).join("; ")}`;
  else if (!reviewCurrent) next = `review this design: board_review {"action":"run"} (${rv ? `review ${rv.state}` : "no review yet"})`;
  else if (rv && rv.open) next = `settle the review's ${rv.open} open finding(s)${rv.mustFix ? ` (${rv.mustFix} must-fix)` : ""}: board_review {"action":"gate"}, then fix or record a disposition`;
  else if (failing.length) next = `${failing.join(", ")} failed at onboarding too: fix them (${failing.map((c) => `${c}: ${FIX[c]}`).join("; ")}) or record the owner's exception before release`;
  else if (!releaseCurrent) next = `release: board_release {"action":"check"}, then {"action":"fab"}${rel ? ` (newest package ${rel.package} is for an older design)` : ""}`;
  else next = `done: ${rel!.package} is the release of this exact design`;
  return {
    onboarding: ob ? { confirmed: ob.confirmed } : null,
    review: rv ? { state: rv.state, open: rv.open, mustFix: rv.mustFix } : null,
    release: rel ? { package: rel.package, current: releaseCurrent } : null,
    next,
  };
}

export function statusLines(s: WorkflowStatus): string[] {
  const ob = s.onboarding ? (s.onboarding.confirmed ? "confirmed" : 'not yet confirmed (board_check {"confirm":true} once checked against the circuit)') : "none";
  const rv = s.review ? `${s.review.state}${s.review.state === "current" ? `, ${s.review.open} open${s.review.mustFix ? ` (${s.review.mustFix} must-fix)` : ""}` : ""}` : "none";
  const rel = s.release ? `${s.release.package} (${s.release.current ? "this design" : "an older design"})` : "none";
  return [`Workflow: onboarding ${ob}; review ${rv}; release ${rel}.`, `Next: ${s.next}`];
}
