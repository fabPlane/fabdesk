/**
 * The owner's intent file, `.fabdesk/board/review/intent.json` (the toolkit's `pcb intent`): goal, constraints,
 * preferences (how far the agent's own judgement goes) and decisions (owner answers that settle the findings they cover
 * in every later review, read by `evaluate` and `propose`).
 *
 *   intentInit    a skeleton: constraints taken from the requirements (fixed parts, height limits), the goal left to the
 *                 owner, the default preferences (ask the owner for hard-constraint changes, spending, accepting a must-fix)
 *   intentDecide  record one owner answer with the finding-id patterns it covers
 *   intentShow    the file as lines
 */
import { join } from "node:path";
import { exists, readJsonOrNull, writeJsonFile } from "../files";
import { readRequirements, requirementsDir } from "../onboard";
import { coveringDecision } from "./proposals";
import { intentPath, loadCurrent } from "./store";
import type { ReviewProject } from "./context";
import type { Intent } from "./types";

type Decision = NonNullable<Intent["decisions"]>[number];

const DEFAULT_ASK = ["changes to a hard constraint", "anything that spends money or orders", "accepting a must-fix"];

/** The skeleton intent for a project; throws when the file exists (it is the owner's: never overwritten). */
export async function intentInit(project: ReviewProject): Promise<{ path: string; intent: Intent; lines: string[] }> {
  const path = intentPath(project.dir);
  if (await exists(path)) throw new Error(`${path} exists: it is the owner's file (intent_decide adds to it)`);
  const req = await readRequirements(project.dir);
  const rdir = requirementsDir(project.dir);
  const fixed = req ? req.mechanical.anchors.map((a) => a.reference) : null;
  const cons: NonNullable<Intent["constraints"]> = [
    {
      id: "fixed",
      kind: "hard",
      text: `fixed parts keep pose and face (requirements fixed: ${fixed ? JSON.stringify(fixed) : "? (not onboarded: board_check onboards the board)"})`,
      source: req ? join(rdir, "mechanical.json") : "",
    },
  ];
  const h = req?.acceptance.heights;
  // 1e9 = unset in onboarded boards
  if (h && [h.F_max_mm, h.B_max_mm].some((v) => 0 < (v || 0) && (v || 0) < 1e6))
    cons.push({ id: "heights", kind: "hard", text: `top <= ${h.F_max_mm} mm, bottom <= ${h.B_max_mm} mm`, source: join(rdir, "acceptance.json") });
  const intent: Intent = {
    schema: "INTENT_V1",
    board: project.name,
    goal: "TODO (owner): what this board is for, in one line",
    constraints: cons,
    preferences: { ask_owner_for: [...DEFAULT_ASK] },
    decisions: [],
  };
  await writeJsonFile(path, intent);
  return { path, intent, lines: [`wrote ${path}: fill the goal; constraints taken from the requirements`, ...showLines(project.name, intent)] };
}

export interface DecideInput {
  id: string;
  decision: string;
  /** Finding-id patterns it settles (fnmatch: `*`, `?`, `[seq]`), e.g. `L4:MOUTH:J1:*`. */
  covers?: string[];
  effect?: string;
  date?: string;
}

/** Record one owner decision; it settles every matching finding in this and every later review. */
export async function intentDecide(project: ReviewProject, input: DecideInput): Promise<{ path: string; decision: Decision; settles: string[]; lines: string[] }> {
  const path = intentPath(project.dir);
  const it = await readJsonOrNull<Intent>(path);
  if (!it) throw new Error(`no intent for ${project.name}: board_review {"action": "intent_init"} first`);
  if (!input.id.trim()) throw new Error("decide needs an id");
  if (!input.decision.trim()) throw new Error("decide needs the decision text");
  const decisions = (it.decisions ??= []);
  if (decisions.some((d) => d.id === input.id)) throw new Error(`decision ${input.id} exists`);
  const covers = (input.covers ?? []).filter(Boolean);
  const d: Decision = {
    id: input.id,
    date: input.date ?? new Date().toISOString().slice(0, 10),
    by: "owner",
    decision: input.decision,
    covers: covers.map((c) => ({ id: c })),
    effect: input.effect ?? "",
    source: `board_review intent_decide ${project.name}`,
  };
  decisions.push(d);
  await writeJsonFile(path, it);
  // what it settles in the latest review now (current or not: the ids carry)
  const cur = await loadCurrent(project);
  const settles = (cur.review?.findings ?? []).filter((f) => f.severity !== "note" && coveringDecision(f, { decisions: [d] })).map((f) => f.id);
  const lines = [
    `recorded ${d.id}; it settles ${covers.length ? covers.join(", ") : "no findings"} in every later review`,
    ...(cur.review ? [`  in the latest review: ${settles.length ? settles.join(", ") : "no finding matches"}`] : []),
  ];
  return { path, decision: d, settles, lines };
}

export function showLines(name: string, it: Intent): string[] {
  const out = [`${name} intent`, `  goal  ${it.goal ?? ""}`];
  for (const c of it.constraints ?? []) out.push(typeof c === "string" ? `  hard  ${c.slice(0, 110)}` : `  ${c.kind.padEnd(4)}  ${c.id}: ${c.text.slice(0, 110)}`);
  for (const [k, v] of Object.entries(it.preferences ?? {})) out.push(`  pref  ${k}: ${typeof v === "string" ? v : (v as string[]).join("; ")}`.slice(0, 150));
  for (const d of it.decisions ?? []) {
    const cov = (d.covers ?? []).map((c) => c.id ?? `${c.rule ?? ""} ${c.refs?.join(",") ?? ""}`.trim()).join(", ");
    out.push(`  dec   ${d.id} (${d.date ?? ""}): ${d.decision.slice(0, 90)}` + (cov ? `  [settles: ${cov}]` : ""));
  }
  return out;
}

export async function intentShow(project: ReviewProject): Promise<{ path: string; intent: Intent | null; lines: string[] }> {
  const path = intentPath(project.dir);
  const it = await readJsonOrNull<Intent>(path);
  if (!it) return { path, intent: null, lines: [`no intent for ${project.name}: board_review {"action": "intent_init"} writes a skeleton`] };
  return { path, intent: it, lines: showLines(project.name, it) };
}
