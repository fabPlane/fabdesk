/**
 * The review -> edit bridge: `board_review fix apply` turns an edit proposal (a decoupling capacitor moved next to its
 * pin, one added) into a candidate board with `runEdit`, then reviews the candidate and reports READY only when
 *   - the edit proof passes (A1-A9 against the source, planned versus collateral diff),
 *   - the finding that asked for it is gone from the candidate's review,
 *   - the candidate's review has no must-fix or question finding the source's review did not have, and
 *   - nothing outside the plan moved or lost copper (0 collateral nets, 0 unplanned parts moved), and
 *   - the candidate's review ran every check without an error (a finding whose check errored is not gone).
 * The source project is never touched; adopting the candidate is `board_edit adopt` or `board_check`'s adopt path.
 */
import { join } from "node:path";
import { runEdit, type EditRunners } from "./edit";
import { writeJsonFile } from "./files";
import { loadCurrent, openReviewProject } from "./review/store";
import { runReview, type EditCandidateBuilder } from "./review/review";
import type { ReviewEnv, ReviewProject } from "./review/context";

export interface EditBridgeOptions {
  project: ReviewProject;
  runners: EditRunners;
  reviewEnv: ReviewEnv;
  offline?: boolean;
  /** The review of the candidate folder (default: the library's `runReview` on the candidate as a project). */
  reviewCandidate?: typeof runReview;
}

export function createEditCandidateBuilder(o: EditBridgeOptions): EditCandidateBuilder {
  return {
    async build(plan, finding) {
      const notes: string[] = [];
      // the workflow solves an edit stop itself, least disturbance first (the toolkit's ladder): the nearest legal spot with
      // nothing displaced, then room made among neighbours within 2 mm, then 4 mm
      const ladder: Array<[string, boolean, number | null]> = [["nearest legal spot, nothing displaced", false, null], ["make room, neighbours <= 2 mm", true, 2], ["make room, neighbours <= 4 mm", true, 4]];
      let res!: Awaited<ReturnType<typeof runEdit>>;
      let rung = "";
      for (const [label, room, radius] of ladder) {
        const p = JSON.parse(JSON.stringify(plan)) as typeof plan;
        for (const m of p.move ?? []) m.make_room = room;
        if (radius) p.displace = { radius, rotations: "keep" };
        res = await runEdit({ projectDir: o.project.dir, plan: p, mode: "full", runners: o.runners });
        // a source that already fails checks is judged by "no new failure" (the toolkit's --heldout when its review's acceptance fails)
        const inherited = /^STOP the source project fails \[([^\]]*)\] before the edit/.exec(res.verdict)?.[1];
        if (inherited) {
          p.accept_before = { ...(p.accept_before ?? {}), ...Object.fromEntries([...inherited.matchAll(/'(\w+)'/g)].map((m) => [m[1]!, "inherited: the source already fails this check; judged by no new failure"])) };
          res = await runEdit({ projectDir: o.project.dir, plan: p, mode: "full", runners: o.runners });
        }
        rung = label;
        if (res.stage !== "impact") break;
        notes.push(`${label}: ${res.verdict}`);
      }
      notes.push(`${rung}; ${res.verdict}`);
      if (res.stage !== "proof" || !res.candidate || !res.proof) return { id: plan.id, ready: false, notes: [...notes, ...(res.stop ? ["a decision is needed (see board_edit impact)"] : [])] };
      const dir = res.candidate.dir;
      const source = await loadCurrent(o.project);
      const before = new Set((source.review?.findings ?? []).filter((f) => f.severity !== "note").map((f) => f.id));
      const cand = await openReviewProject(dir);
      const review = await (o.reviewCandidate ?? runReview)(cand, o.reviewEnv, { offline: o.offline ?? true });
      const after = review.review.findings.filter((f) => f.severity !== "note");
      const gone = !after.some((f) => f.id === finding.id);
      const added = after.filter((f) => !before.has(f.id)).map((f) => f.id);
      const collateral = res.churn?.collateral_nets ?? 0;
      const unplanned = res.churn?.unplanned_moved.length ?? 0;
      const proofPass = res.proof.pass;
      // a finding that vanished because its check errored is not gone: a candidate review with check errors is never READY
      const checkErrors = (review.review.checks ?? []).filter((c) => c.status === "error").map((c) => c.name);
      notes.push(gone ? `finding ${finding.id} gone` : `finding ${finding.id} still present`);
      if (added.length) notes.push(`new findings: ${added.slice(0, 5).join(", ")}${added.length > 5 ? ` and ${added.length - 5} more` : ""}`);
      if (collateral || unplanned) notes.push(`collateral: ${collateral} nets, ${unplanned} unplanned parts moved`);
      if (!proofPass) notes.push("the A1-A9 proof does not pass");
      if (checkErrors.length) notes.push(`the candidate's review had check errors (${checkErrors.join(", ")}): its findings cannot be trusted`);
      const ready = proofPass && gone && added.length === 0 && collateral === 0 && unplanned === 0 && checkErrors.length === 0;
      await writeJsonFile(join(dir, "review-bridge.json"), { finding: finding.id, ready, gone, checkErrors, newFindings: added, collateralNets: collateral, unplannedMoved: unplanned, proofPass, reviewRun: review.dir });
      return { id: plan.id, dir, ready, notes };
    },
  };
}
