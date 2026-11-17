/**
 * The review's records. A review covers one design hash; a finding is a question with evidence and needs a
 * disposition unless it is a note. Field names follow the toolkit's `review.json` (REVIEW_V1) so a record from
 * either side can be read by the other.
 */

export const SEVERITIES = ["must-fix", "question", "note"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const STATES = ["fix", "accept", "false-positive", "defer"] as const;
export type DispositionState = (typeof STATES)[number];

export interface Evidence {
  source: string;
  detail: string;
  url?: string;
  hash?: string;
  data?: unknown;
}

export interface Finding {
  /** L0..L8. */
  layer: string;
  /** Short rule id: ERC, DRC, A7, G, F, R, O, DECAP, BOM, COVER, IC, MANUAL, EXPERT ... */
  rule: string;
  severity: Severity;
  /** One line: what is wrong or unknown. */
  claim: string;
  ref: string;
  pad: string;
  net: string;
  /** Disambiguator when ref/pad do not identify the finding. */
  key: string;
  evidence: Evidence[];
  /** What would resolve it. */
  suggest: string;
}

export type FindingInput = Pick<Finding, "layer" | "rule" | "severity" | "claim"> & Partial<Omit<Finding, "layer" | "rule" | "severity" | "claim">>;

export function makeFinding(f: FindingInput): Finding {
  return { ref: "", pad: "", net: "", key: "", evidence: [], suggest: "", ...f };
}

export function findingId(f: Pick<Finding, "layer" | "rule" | "ref" | "pad" | "key">): string {
  const parts = [f.layer, f.rule, f.ref || "-", f.pad || "-", ...(f.key ? [f.key] : [])];
  return parts.join(":").replace(/[^A-Za-z0-9_.+:-]+/g, "_");
}

export type CheckStatus = "ok" | "skipped" | "error";

export interface CheckResult {
  name: string;
  layer: string;
  status: CheckStatus;
  seconds: number;
  detail: string;
  findings: Finding[];
  artifacts: Record<string, unknown>;
}

export function newResult(name: string, layer: string): CheckResult {
  return { name, layer, status: "ok", seconds: 0, detail: "", findings: [], artifacts: {} };
}

export type ProposalApply =
  | { kind: "disposition"; state: DispositionState; as?: "owner" | "agent"; reason: string; third_source?: string; approval?: OwnerApproval }
  | { kind: "edit"; plan: EditPlan }
  | { kind: "command"; cmd: string }
  | { kind: "task"; steps: string[] };

/** What a decoupling (or other layout) proposal asks of the edit stage: the toolkit's edit-plan shape. */
export interface EditPlan {
  id: string;
  authority: string;
  reason: string;
  board: string;
  project: string;
  spec: string;
  move?: Array<{ ref: string; near: string; make_room: boolean }>;
  add?: Array<{
    ref: string;
    like: string;
    value: string;
    footprint: string;
    pins: Record<string, string>;
    near: number[];
    fields: Record<string, string>;
  }>;
  displace?: { radius: number; rotations: string };
  /** Checks the source already fails, named with the reason; the edit is then judged by no new failure. */
  accept_before?: Record<string, string>;
}

export interface Proposal {
  by: "workflow" | "owner";
  action: string;
  effect: string;
  apply: ProposalApply;
}

export interface FindingRecord extends Finding {
  id: string;
  check: string;
  proposal: Proposal | null;
}

export interface CheckRecord {
  name: string;
  layer: string;
  status: CheckStatus;
  seconds: number;
  detail: string;
  artifacts: Record<string, unknown>;
}

export interface ReviewRecord {
  schema: "REVIEW_V1";
  board: string;
  /** The board file reviewed, project-relative with "/" (a review of one board never passes another). */
  pcb?: string;
  config: string;
  hash: string;
  files: Record<string, string>;
  kicad: string;
  started: string;
  finished: string;
  seconds: number;
  partial: boolean;
  checks: CheckRecord[];
  findings: FindingRecord[];
}

/**
 * The person at the desktop (or a paired device) approved an owner decision through the run's approval card. An owner
 * disposition, decision or delegation counts as the owner's only with one of these (`ownerConfirmed`).
 */
export interface OwnerApproval {
  approved: boolean;
  requestId: string;
  by: string;
  at: string;
}

export interface Disposition {
  state: DispositionState;
  by: string;
  /** For by: "owner": the approval card that confirmed it. */
  approval?: OwnerApproval;
  reason: string;
  third_source?: string;
  evidence?: string;
  date?: string;
  hash?: string;
  claim?: string;
  via?: string;
}

export type Dispositions = Record<string, Disposition>;

/** The owner's intent file: decisions that settle findings, and how far the agent's own judgement goes. */
export interface Intent {
  schema?: "INTENT_V1";
  board?: string;
  goal?: string;
  /** Hard or soft limits the workflow keeps (the toolkit writes objects; plain strings are read too). */
  constraints?: Array<string | { id: string; kind: "hard" | "soft" | string; text: string; source?: string }>;
  decisions?: Array<{
    id: string;
    decision: string;
    date?: string;
    by?: string;
    effect?: string;
    source?: string;
    /** Findings it settles: an id pattern (fnmatch), or a rule with optional refs. */
    covers?: Array<{ id?: string; rule?: string; refs?: string[] }>;
    /** The approval card that confirmed it; a decision without one settles nothing. */
    approval?: OwnerApproval;
  }>;
  preferences?: { ask_owner_for?: string[]; workflow_decides?: string[] };
  /** The approval card that confirmed these exact preferences (`sha256` of their JSON); without it the defaults apply. */
  preferences_approval?: OwnerApproval & { sha256: string };
}

/** Review settings of the project (`.fabdesk/board/review/config.json`). Every key is optional. */
export interface ReviewConfig {
  checks_only?: string[];
  checks_skip?: string[];
  hash_extra?: string[];
  native?: { judged_elsewhere?: Array<{ type: string; match: string; by: string; reason: string }> };
  decoupling?: { max_mm?: number; max_mm_bulk?: number };
  current_check?: { rise_max_c?: number; drop_max_pct?: number; min_track_mm?: number; method?: "ipc2152" | "ipc2221" };
  currents?: Record<string, number>;
  /** The complete inner-power audit (`inner_power` check): on (optionally with limits) or off; default on when the acceptance has a `supplier_stack`. */
  inner_power?: boolean | { rise_max_c?: number; drop_max_pct?: number };
  impedance?: { model_uncertainty_pct?: number; min_run_mm?: number };
  net_voltages?: Record<string, number>;
  manual_review?: string[];
  mouth?: { edge_mm?: number; skip?: string[]; inward_ok?: Record<string, unknown>; min_offset_mm?: number };
  assembly?: { sides?: string[]; post_assembly?: Record<string, unknown>; cpl?: string };
  bom?: Record<string, unknown>;
  custom?: CustomSpec[];
  board_id?: string;
  /** The silk check's rules: a silk plan (`board_silk`'s `plan`: heights, stroke, clear, skip, hide, inside_ok ...). */
  silk?: Record<string, unknown>;
}

export interface CustomSpec {
  name: string;
  layer?: string;
  boards?: string[];
  /** Shell command with {pcb} {sch} {project} {netlist} {spec} {out}. Prints a JSON list of findings. */
  run: string;
  timeout?: number;
  /** "sh" | "bash" | "cmd" | "powershell" | "pwsh"; default the platform shell (`/bin/sh`, Windows `cmd.exe`). */
  shell?: string;
  _src?: string;
}
