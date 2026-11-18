import { coveringDecision } from "./proposals";
import { STATES } from "./types";
import type { Disposition, Dispositions, FindingRecord, Intent } from "./types";

/** Coverage waivers disclose their author, but do not claim an independent review ran. */
function isCoverageQuestion(f: { layer?: string; rule?: string; key?: string }): boolean {
  return f.layer === "L8" && f.rule === "EXPERT" && ["pending", "earlier"].includes(f.key ?? "");
}

/** The owner's intent decides how far the agent's judgement goes, not the tool. Default: accepting a must-fix is the owner's. */
export function agentMayAcceptMustFix(intent: Intent | null): boolean {
  const pref = intent?.preferences ?? {};
  const intentGiven = !!intent && Object.keys(intent).length > 0;
  const ask = (pref.ask_owner_for ?? (intentGiven ? [] : ["accepting a must-fix"])).join(" ").toLowerCase();
  const allow = (pref.workflow_decides ?? []).join(" ").toLowerCase();
  return allow.includes("must-fix") || !ask.includes("must-fix");
}

/** (open?, why) for one finding under its disposition. Every rule asks for evidence, not for a particular path. */
export function judge(finding: { severity: string; layer?: string; rule?: string; key?: string }, disp: Disposition | null | undefined, intent: Intent | null = null): [boolean, string] {
  if (finding.severity === "note") return [false, "note"];
  if (!disp) return [true, "no disposition"];
  if (!disp.by) return [true, "disposition ignored: no author"];
  if (disp.by !== "agent" && disp.by !== "owner") return [true, `disposition ignored: unrecognised author ${disp.by}`];
  if (!STATES.includes(disp.state)) return [true, `disposition ignored: unrecognised state ${disp.state}`];
  const st = disp.state;
  if (typeof disp.reason !== "string" || !disp.reason.trim()) return [true, "disposition has no reason"];
  if (st === "defer" && finding.severity === "must-fix") return [true, "must-fix deferred, not resolved"];
  if (st === "fix") return [true, "marked fix but still present"];
  if (st === "false-positive" && !disp.third_source) return [true, "false-positive needs a third source"];
  if (finding.severity === "must-fix" && st === "accept" && disp.by !== "owner") {
    if (!agentMayAcceptMustFix(intent)) return [true, "must-fix accepted by agent: the owner's intent asks to be asked"];
    if (!(disp.third_source || disp.evidence)) return [true, "must-fix accepted by agent needs evidence (third_source)"];
  }
  // The agent cannot waive a question on its own say-so: deferring one is the owner's call, and accepting one needs a
  // source beyond the design and the check, unless the owner's intent hands questions to the workflow.
  if (finding.severity === "question" && disp.by !== "owner" && !isCoverageQuestion(finding)) {
    if (st === "defer") return [true, "question deferred by agent: the owner decides"];
    if (st === "accept" && !(disp.third_source || disp.evidence) && !agentMayAcceptQuestion(intent)) return [true, "question accepted by agent needs evidence (third_source) or the owner"];
  }
  return [false, st];
}

/** The owner's intent may hand questions to the workflow (`workflow_decides` naming "question"). */
export function agentMayAcceptQuestion(intent: Intent | null): boolean {
  return (intent?.preferences?.workflow_decides ?? []).join(" ").toLowerCase().includes("question");
}

export interface Row extends FindingRecord {
  open: boolean;
  why: string;
  disposition: Disposition | null;
  carried: boolean;
}

/** Resolve explicit dispositions and owner intent once for findings and coverage alike. */
export function evaluateFinding(f: FindingRecord, disps: Dispositions, intent: Intent | null, hash: string): Row {
  let d: Disposition | null = disps[f.id] ?? null;
  const dec = !d ? coveringDecision(f, intent ?? {}) : null;
  if (dec)
    d = { state: "accept", by: "owner", reason: `intent decision ${dec.id}: ${dec.decision}`, third_source: dec.source ?? "", hash };
  const [open, why] = judge(f, d, intent);
  return { ...f, open, why: why.replace("disposition ignored:", `disposition for ${f.id} ignored:`), disposition: d, carried: !!(d?.hash && d.hash !== hash) };
}
