/**
 * The review -> edit bridge: `board_review fix apply` turns an edit proposal (a decoupling capacitor moved next to its
 * pin, one added) into a candidate board with `runEdit`, then reviews the candidate and reports READY only when
 *   - the edit proof passes (A1-A9 against the source, planned versus collateral diff),
 *   - the finding that asked for it is gone from the candidate's review,
 *   - the candidate's review has no must-fix or question finding the source's review did not have, and
 *   - nothing outside the plan moved or lost copper (0 collateral nets, 0 unplanned parts moved), and
 *   - the candidate's review ran every check without an error (a finding whose check errored is not gone).
 * The source project is never touched; adopting the candidate is `board_edit adopt` or `board_check`'s adopt path.
 *
 * `build` takes a workflow proposal's plan up the toolkit's ladder (nearest legal spot, then make room within 2 mm,
 * then 4 mm); `prove` takes one plan as written (the agent's own plan for `review try`, or the combined candidate) and
 * targets any number of findings: every one must be gone.
 */
import { join } from "node:path";
import { runEdit, type EditRunners } from "./edit";
import { writeJsonFile } from "./files";
import { loadCurrent, openReviewProject } from "./review/store";
import { runReview, type Candidate, type EditCandidateBuilder } from "./review/review";
import type { EditPlan, FindingRecord } from "./review/types";
import type { ReviewEnv, ReviewProject } from "./review/context";

export interface EditBridgeOptions {
  project: ReviewProject;
  runners: EditRunners;
  reviewEnv: ReviewEnv;
  offline?: boolean;
  /** The review of the candidate folder (default: the library's `runReview` on the candidate as a project). */
  reviewCandidate?: typeof runReview;
}

type Run = Awaited<ReturnType<typeof runEdit>>;

export function createEditCandidateBuilder(o: EditBridgeOptions): EditCandidateBuilder {
  /** One plan through the edit pipeline (full: apply, repair, A1-A9 proof, collateral diff). */
  const edit = async (p: EditPlan): Promise<Run> => {
    let res = await runEdit({ projectDir: o.project.dir, plan: p, mode: "full", runners: o.runners });
    // a source that already fails checks is judged by "no new failure" (the toolkit's --heldout when its review's acceptance fails)
    const inherited = /^STOP the source project fails \[([^\]]*)\] before the edit/.exec(res.verdict)?.[1];
    if (inherited) {
      p.accept_before = { ...(p.accept_before ?? {}), ...Object.fromEntries([...inherited.matchAll(/'(\w+)'/g)].map((m) => [m[1]!, "inherited: the source already fails this check; judged by no new failure"])) };
      res = await runEdit({ projectDir: o.project.dir, plan: p, mode: "full", runners: o.runners });
    }
    return res;
  };

  /** The candidate an edit produced, reviewed: READY only when every targeted finding is gone and nothing else changed. */
  const judgeCandidate = async (res: Run, plan: EditPlan, findings: FindingRecord[], notes: string[]): Promise<Candidate> => {
    const base = { id: plan.id, plan, verdict: res.verdict };
    if (res.stage !== "proof" || !res.candidate || !res.proof) return { ...base, ready: false, notes: [...notes, ...(res.stop ? ["a decision is needed (see board_edit impact)"] : [])] };
    const dir = res.candidate.dir;
    const source = await loadCurrent(o.project);
    const before = new Set((source.review?.findings ?? []).filter((f) => f.severity !== "note").map((f) => f.id));
    const cand = await openReviewProject(dir);
    const review = await (o.reviewCandidate ?? runReview)(cand, o.reviewEnv, { offline: o.offline ?? true });
    const after = review.review.findings.filter((f) => f.severity !== "note");
    const left = findings.filter((f) => after.some((a) => a.id === f.id)).map((f) => f.id);
    const added = after.filter((f) => !before.has(f.id)).map((f) => f.id);
    const collateral = res.churn?.collateral_nets ?? 0;
    const unplanned = res.churn?.unplanned_moved.length ?? 0;
    const proofPass = res.proof.pass;
    // a finding that vanished because its check errored is not gone: a candidate review with check errors is never READY
    const checkErrors = (review.review.checks ?? []).filter((c) => c.status === "error").map((c) => c.name);
    for (const f of findings) notes.push(left.includes(f.id) ? `finding ${f.id} still present` : `finding ${f.id} gone`);
    if (added.length) notes.push(`new findings: ${added.slice(0, 5).join(", ")}${added.length > 5 ? ` and ${added.length - 5} more` : ""}`);
    if (collateral || unplanned) notes.push(`collateral: ${collateral} nets, ${unplanned} unplanned parts moved`);
    if (!proofPass) notes.push("the A1-A9 proof does not pass");
    if (checkErrors.length) notes.push(`the candidate's review had check errors (${checkErrors.join(", ")}): its findings cannot be trusted`);
    const ready = proofPass && left.length === 0 && added.length === 0 && collateral === 0 && unplanned === 0 && checkErrors.length === 0;
    await writeJsonFile(join(dir, "review-bridge.json"), { finding: findings[0]?.id ?? null, findings: findings.map((f) => f.id), ready, gone: left.length === 0, stillOpen: left, checkErrors, newFindings: added, collateralNets: collateral, unplannedMoved: unplanned, proofPass, reviewRun: review.dir });
    return { ...base, dir, ready, notes, stillOpen: left, newFindings: added, collateralNets: collateral, unplannedMoved: unplanned, proofPass };
  };

  return {
    async build(plan, finding) {
      const notes: string[] = [];
      // the workflow solves an edit stop itself, least disturbance first (the toolkit's ladder): the nearest legal spot with
      // nothing displaced, then room made among neighbours within 2 mm, then 4 mm
      const ladder: Array<[string, boolean, number | null]> = [["nearest legal spot, nothing displaced", false, null], ["make room, neighbours <= 2 mm", true, 2], ["make room, neighbours <= 4 mm", true, 4]];
      let res!: Run;
      let used = plan;
      let rung = "";
      for (const [label, room, radius] of ladder) {
        const p = JSON.parse(JSON.stringify(plan)) as typeof plan;
        for (const m of p.move ?? []) m.make_room = room;
        if (radius) p.displace = { radius, rotations: "keep" };
        res = await edit(p);
        used = p;
        rung = label;
        if (res.stage !== "impact") break;
        notes.push(`${label}: ${res.verdict}`);
      }
      notes.push(`${rung}; ${res.verdict}`);
      return judgeCandidate(res, used, [finding], notes);
    },
    async prove(plan, findings) {
      // the agent's own plan (or the combined one) as written: no ladder, the same proof
      const p = JSON.parse(JSON.stringify(plan)) as EditPlan;
      const res = await edit(p);
      return judgeCandidate(res, p, findings, [res.verdict]);
    },
  };
}
