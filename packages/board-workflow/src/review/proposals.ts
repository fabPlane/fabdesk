/**
 * A solution for every finding: what to do, who does it, what it changes in practice, and how to apply it.
 *
 * The owner gives intent (`.fabdesk/board/review/intent.json`: goal, constraints, decisions, preferences); the workflow
 * handles the rest. A finding never reaches the owner as a bare block: it carries a proposal first.
 *
 *   by      "workflow"  the workflow can do it (`board_review fix`)
 *           "owner"     only the owner can decide it; the proposal says why and what each choice changes
 *   apply   {kind: "disposition", ...}  settle with a reason (an owner decision on record, or evidence)
 *           {kind: "edit", plan}        an edit plan for the edit stage; applied to a candidate copy, never to the source
 *           {kind: "command", cmd}      a command
 *           {kind: "task", steps}       work the agent does by hand, listed exactly
 */
import type { Comp } from "./netlist";
import type { EditPlan, Finding, FindingRecord, Intent, Proposal } from "./types";
import { ownerConfirmed } from "./owner";

type Decision = NonNullable<Intent["decisions"]>[number];

/** Python's fnmatch: `*`, `?`, `[seq]`, matched against the whole string. */
export function fnmatch(name: string, pat: string): boolean {
  let rx = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i]!;
    if (c === "*") rx += ".*";
    else if (c === "?") rx += ".";
    else if (c === "[") {
      const j = pat.indexOf("]", i + 2);
      if (j < 0) rx += "\\[";
      else {
        let body = pat.slice(i + 1, j);
        if (body[0] === "!") body = "^" + body.slice(1);
        rx += `[${body.replace(/\\/g, "\\\\")}]`;
        i = j;
      }
    } else rx += c.replace(/[.+^${}()|\\/-]/g, "\\$&");
  }
  return new RegExp(`^${rx}$`, "s").test(name);
}

/** The owner decision that settles a finding. Only a decision confirmed at the desktop (`ownerConfirmed`) counts. */
export function coveringDecision(f: Pick<Finding, "rule" | "ref"> & { id: string }, intent: Intent): Decision | null {
  for (const d of (intent.decisions ?? []).filter(d => ownerConfirmed(d.approval)))
    for (const c of d.covers ?? []) {
      if (c.id && fnmatch(f.id, c.id)) return d;
      if (c.rule && c.rule === f.rule && (!c.refs?.length || c.refs.includes(f.ref))) return d;
    }
  return null;
}

export interface ProposalInfo {
  oracle_pins: Record<string, number>;
  comps: Map<string, Comp> | null;
}

export interface ProposalTarget {
  dir: string;
  /** True when the project has requirements (a flow board in the toolkit's sense). */
  hasRequirements: boolean;
}

function decapPlan(f: FindingRecord, board: ProposalTarget, info: ProposalInfo): EditPlan | null {
  const comps = info.comps ?? new Map<string, Comp>();
  const used = new Set(comps.keys());
  const moves: NonNullable<EditPlan["move"]> = [];
  const adds: NonNullable<EditPlan["add"]> = [];
  for (const e of f.evidence) {
    const dt = e.data as { cap?: string | null; dist?: number | null; limit?: number; pin?: string; net?: string; xy?: number[] } | undefined;
    if (!dt) continue;
    const { cap, dist } = dt;
    const lim = dt.limit ?? 5.0;
    if (cap && dist !== null && dist !== undefined && dist <= 2 * lim) {
      if (!moves.some((m) => m.ref === cap)) moves.push({ ref: cap, near: `${f.ref}.${dt.pin}`, make_room: true });
    } else if (cap && comps.has(cap)) {
      const like = comps.get(cap)!;
      const m = /^(.*?)(\d+)$/.exec(cap);
      const prefix = m ? m[1]! : "C";
      let n = 900;
      while (used.has(`${prefix}${n}`)) n++;
      used.add(`${prefix}${n}`);
      const gnd = [...like.pins.values()].find((v) => v.net !== dt.net)?.net;
      if (gnd !== undefined) {
        const pins = Object.fromEntries([...like.pins].map(([p, v]) => [p, v.net === dt.net ? dt.net! : v.net]));
        adds.push({
          ref: `${prefix}${n}`,
          like: cap,
          value: like.value,
          footprint: like.footprint,
          pins,
          near: dt.xy ?? [],
          fields: Object.fromEntries(Object.entries(like.fields).filter(([k]) => ["LCSC", "LCSC Part", "MPN", "Manufacturer"].includes(k))),
        });
      }
    }
  }
  if (!moves.length && !adds.length) return null;
  const plan: EditPlan = { id: `fix-${f.id.replace(/[^\w.-]+/g, "_")}`, authority: "review proposal (workflow)", reason: f.claim.slice(0, 200), board: board.dir, project: board.dir, spec: "" };
  if (moves.length) plan.move = moves.slice(0, 4);
  if (adds.length) plan.add = adds.slice(0, 4);
  return plan;
}

export function propose(f: FindingRecord | (Finding & { id: string }), board: ProposalTarget, intent: Intent, info: ProposalInfo, name = ""): Proposal | null {
  if (f.severity === "note") return null;
  const d = coveringDecision(f, intent);
  if (d)
    return {
      by: "workflow",
      action: `settle by owner decision '${d.id}' (${d.date ?? ""}): ${d.decision.slice(0, 140)}`,
      effect: d.effect ?? "already decided by the owner",
      apply: { kind: "disposition", state: "accept", as: "owner", reason: `owner decision ${d.id} (${d.date ?? ""}): ${d.decision.slice(0, 200)}`, third_source: d.source ?? "", ...(d.approval ? { approval: d.approval } : {}) },
    };
  const r = f.rule, claim = f.claim;
  if (r === "DECAP" && board.hasRequirements) {
    const plan = decapPlan(f as FindingRecord, board, info);
    if (plan) {
      const what = [...(plan.move ?? []).map((m) => `move ${m.ref} next to ${m.near}`), ...(plan.add ?? []).map((a) => `add ${a.ref} (${a.value}, like ${a.like}) at the pin`)];
      return { by: "workflow", action: what.join("; "), effect: "a candidate board with the capacitor(s) at the pin, then last-mile repair and a re-review; the source is untouched", apply: { kind: "edit", plan } };
    }
  }
  if (r === "G") {
    const n = info.oracle_pins[f.ref] ?? 0;
    if (n)
      return { by: "workflow", action: `settle: JLC's own symbol confirms all ${n} pins against the nets`, effect: "nothing changes on the board; the symbol stays generic until the sheet is next edited", apply: { kind: "disposition", state: "accept", as: "agent", reason: `pin map confirmed by JLC symbol (${n} pins, no contradiction)` } };
    return { by: "workflow", action: "confirm every pin against the datasheet table, or swap to a real symbol", effect: "no copper change", apply: { kind: "task", steps: [`compare ${f.ref} pins with its datasheet pin table`] } };
  }
  if (r === "F") {
    const powerSwitch = /FAULT|FLT|OC/.test(claim) && !/\bINT\b|~\{INT\}/.test(claim);
    if (powerSwitch)
      return { by: "owner", action: `route ${f.ref}.${f.pad} to a GPIO or a test pad (recommended), or accept a silent fault`, effect: "routed: a short/overcurrent on that port becomes visible at bring-up (A3.8.7 lost bench sessions to this); accepted: the board stays as is", apply: { kind: "task", steps: [`add a test pad on ${f.ref}.${f.pad} (edit add like an existing TP) or route to a free MCU pin`] } };
    return { by: "workflow", action: `check whether firmware polls ${f.ref} instead of using ${f.ref}.${f.pad}; settle with that evidence, or route the pin`, effect: "nothing changes unless the pin is needed; recorded so bring-up knows whether it is monitored", apply: { kind: "task", steps: [`find how ${f.ref} is read (firmware, schematic notes) and dispose with that as the reason`] } };
  }
  if (r === "O") return { by: "workflow", action: "check the pin in the datasheet; if JLC's symbol is wrong, add it to review/oracle-errata.json", effect: "no copper change unless our symbol is the wrong one", apply: { kind: "task", steps: ["datasheet pin table vs both symbols"] } };
  if (r === "SKEW") return { by: "workflow", action: `tune the pair in the last mile (\`pairs\` / \`bundle:\` on ${f.net})`, effect: "a candidate with the pair matched; the owner sees only the result", apply: { kind: "command", cmd: `board_edit {"action": "last_mile", "goal": "pairs"}   # on a workspace of ${name}` } };
  if (r === "GIT") return { by: "workflow", action: "commit the design files so the review covers a state anyone can check out", effect: "none on the board", apply: { kind: "command", cmd: `git -C ${board.dir} add -A . && git commit (design files only)` } };
  if (r === "SPEC") return { by: "workflow", action: "point the requirements at the release requirements, or record why the work copy is authoritative", effect: "none on the board", apply: { kind: "task", steps: ["edit the requirements path"] } };
  if (r === "ERC" && claim.includes("label_dangling")) return { by: "workflow", action: "delete the dangling global labels listed in the evidence (leftovers of a removed connector)", effect: "schematic only; no copper or net change", apply: { kind: "task", steps: f.evidence.map((e) => e.detail) } };
  if (r === "GATE") return { by: "owner", action: "resolve the contract entry: the remediation in the interconnect contracts says how", effect: "fabrication stays blocked until it passes (custom harnesses are prohibited)", apply: { kind: "task", steps: [claim.slice(0, 300)] } };
  if (r === "BOM") {
    if (claim.includes("stock")) return { by: "workflow", action: "swap to an in-stock alternate of the same value/package/rating (bomcheck lists them), or use JLC global sourcing", effect: "same circuit; part number changes", apply: { kind: "task", steps: ["pick from bomcheck alternates; edit swap fields"] } };
    return { by: "workflow", action: "compare our footprint with the datasheet land pattern / check the JLC preview", effect: "none unless a pad is wrong", apply: { kind: "task", steps: [claim.slice(0, 200)] } };
  }
  if (r === "A8") return { by: "owner", action: "re-route the failing pairs (workflow, last mile) or accept them for this prototype", effect: "re-route: a new candidate; accept: impedance off target on those pairs", apply: { kind: "task", steps: ["last mile: pairs-all"] } };
  if (r === "SILK" && f.key === "labels") return { by: "workflow", action: "re-place the labels (silk stage: clean labels stay, the rest are placed)", effect: "silkscreen only: copper and every other byte of the board unchanged; a label that fits nowhere is hidden and listed", apply: { kind: "command", cmd: "silk place" } };
  if (r === "SILK") return { by: "workflow", action: "look at each outline; move the part if the outline matters, else accept (fab clips silk off pads)", effect: "cosmetic unless the outline marks polarity or pin 1", apply: { kind: "task", steps: f.evidence.map((e) => e.detail) } };
  if (r === "MANUAL") return { by: "workflow", action: "answer it with the tool that measures it (decoupling/return-paths/solver) and record the evidence", effect: "none unless the evidence shows a problem", apply: { kind: "task", steps: [claim] } };
  if (r === "EXPERT") return { by: "owner", action: "start an independent fresh-context reviewer on the evidence pack (costs an agent run; the owner decides)", effect: "a second opinion on what the tools cannot see", apply: { kind: "task", steps: ["a fresh-context reviewer works from pack/EXPERT-BRIEF.md, then board_review import_expert"] } };
  const items = f.evidence.map((e) => (e.detail ?? "").slice(0, 120)).filter(Boolean);
  if ((r === "ERC" || r === "DRC") && items.length) {
    const what: Record<string, string> = {
      track_dangling: "delete the dangling track stubs",
      via_dangling: "delete the unconnected vias",
      lib_footprint_mismatch: "confirm the board copies are the intended footprints (the library copy drifted), then settle",
      pin_to_pin: "confirm each pin pairing is intended (strap or power flag), then settle",
      isolated_pin_label: "remove or connect each single-pin label",
    };
    const key = Object.keys(what).find((k) => f.key.includes(k));
    return {
      by: "workflow",
      action: (key ? what[key]! : `check the ${items.length} listed items, then fix or settle`) + `: ${items[0]}` + (items.length > 1 ? ` (+${items.length - 1})` : ""),
      effect: key && ["track_dangling", "via_dangling", "isolated_pin_label"].includes(key) ? "cleanup; no circuit change" : "none unless an item is wrong",
      apply: { kind: "task", steps: items },
    };
  }
  return { by: "workflow", action: f.suggest || `check and settle: ${claim.slice(0, 120)}`, effect: "", apply: { kind: "task", steps: [claim.slice(0, 200)] } };
}
