/**
 * Supervised runs: what the agent is waiting on and what the phone shows for it. Pure, no React
 * Native, so Bun tests it.
 *
 * The daemon's side of this (the `runtimeMode` field, the `approval` / `question` message parts,
 * the `agent.approval_requested` family of events and `GET /threads/:id`'s `pending`) is being
 * built on another branch against the same contract (`docs/mobile-roadmap.md` Wave 3, A1). Until
 * `@fabdesk/protocol` carries those shapes, the structural types below are the contract verbatim;
 * the integrator swaps them for the protocol's own and nothing else here changes.
 */
import type {
  ApprovalDecision,
  PendingApprovalRequest,
  PendingInputRequest,
  PendingRequestsBlock,
  RuntimeMode,
} from "@fabdesk/client-core";
import type { AgentInfo, Message, MessagePart, Settings, Thread } from "@fabdesk/protocol";

export type { ApprovalDecision, RuntimeMode };

/** `{ type: "approval" }` message part — a tool call the run paused on. */
export interface ApprovalPart {
  type: "approval";
  requestId: string;
  tool: string;
  input: unknown;
  summary: string;
  decision: "pending" | ApprovalDecision;
  /** Set once resolved; who answered. Absent while pending or when the daemon omits it. */
  by?: "desktop" | "device" | "timeout" | undefined;
}

/** `{ type: "question" }` message part — the agent asked something; `options` absent = free text. */
export interface QuestionPart {
  type: "question";
  requestId: string;
  question: string;
  options?: string[] | undefined;
  answer: string | null;
}

export type PendingPart = ApprovalPart | QuestionPart;
/** A message part as the phone reads it: the protocol's union plus the two supervised kinds. */
export type AnyPart = MessagePart | PendingPart;

/** `GET /threads/:id` → `pending`: the requests the run is waiting on right now (client-core's shapes). */
export type PendingApproval = PendingApprovalRequest;
export type PendingInput = PendingInputRequest;
export type PendingRequests = PendingRequestsBlock;

/** `Thread` once the daemon has learned supervised mode (`runtimeMode` defaults to `"full"`). */
export type ThreadWithMode = Thread & { runtimeMode?: RuntimeMode | undefined };
/** `AgentInfo` once `/agents` reports whether the adapter can pause; missing means it cannot. */
export type AgentWithSupervised = AgentInfo & { supportsSupervised?: boolean | undefined };
/** `Settings` once `defaultRuntimeMode` exists; missing means `"full"`. */
export type SettingsWithMode = Pick<Settings, "defaultAgent"> & {
  defaultRuntimeMode?: RuntimeMode | undefined;
};

export const EMPTY_PENDING: PendingRequests = { approvals: [], inputs: [] };

export function isPendingPart(part: AnyPart): part is PendingPart {
  return part.type === "approval" || part.type === "question";
}

export function runtimeModeOf(thread: ThreadWithMode | undefined): RuntimeMode {
  return thread?.runtimeMode === "supervised" ? "supervised" : "full";
}

export function defaultRuntimeMode(settings: SettingsWithMode | undefined): RuntimeMode {
  return settings?.defaultRuntimeMode === "supervised" ? "supervised" : "full";
}

/** A missing flag is `false`: the daemon rejects supervised for adapters that cannot pause. */
export function agentSupportsSupervised(agent: AgentWithSupervised | undefined): boolean {
  return agent?.supportsSupervised === true;
}

export interface RuntimeModeOption {
  mode: RuntimeMode;
  label: string;
  hint: string;
  selected: boolean;
  disabled: boolean;
}

/**
 * The two rows of the runtime-mode sheet. Supervised is offered but disabled, with the reason in
 * its hint, for an agent that cannot pause — a greyed row explains more than a missing one.
 */
export function runtimeModeOptions(
  current: RuntimeMode,
  agent: AgentWithSupervised | undefined,
): RuntimeModeOption[] {
  const canSupervise = agentSupportsSupervised(agent);
  const name = agent?.displayName ?? agent?.id ?? "this agent";
  return [
    {
      mode: "full",
      label: "Full access",
      hint: "Tools run without asking",
      selected: current === "full",
      disabled: false,
    },
    {
      mode: "supervised",
      label: "Supervised",
      hint: canSupervise
        ? "Writes and shell commands wait for your approval"
        : `${name} cannot pause for approval`,
      selected: current === "supervised",
      disabled: !canSupervise,
    },
  ];
}

/** Coerces whatever `GET /threads/:id` returned into a `pending` block; older daemons send none. */
export function pendingFromThread(thread: unknown): PendingRequests {
  const pending = (thread as { pending?: unknown } | null | undefined)?.pending;
  if (!pending || typeof pending !== "object") return EMPTY_PENDING;
  const { approvals, inputs } = pending as { approvals?: unknown; inputs?: unknown };
  return {
    approvals: Array.isArray(approvals) ? (approvals as PendingApproval[]) : [],
    inputs: Array.isArray(inputs) ? (inputs as PendingInput[]) : [],
  };
}

export function pendingCount(pending: PendingRequests): number {
  return pending.approvals.length + pending.inputs.length;
}

/** Request ids in `next` that `prev` did not have — the ones worth a haptic. */
export function newRequestIds(prev: PendingRequests | undefined, next: PendingRequests): string[] {
  const seen = new Set<string>();
  for (const a of prev?.approvals ?? []) seen.add(a.requestId);
  for (const i of prev?.inputs ?? []) seen.add(i.requestId);
  const fresh: string[] = [];
  for (const a of next.approvals) if (!seen.has(a.requestId)) fresh.push(a.requestId);
  for (const i of next.inputs) if (!seen.has(i.requestId)) fresh.push(i.requestId);
  return fresh;
}

/**
 * Pending requests that no message part already shows. The daemon puts a request into the run's
 * message parts *and* into `pending`; when the reducer has appended the part the timeline card
 * covers it, and only requests the timeline does not know about yet need a card of their own.
 */
export function unplacedPending(
  messages: readonly Message[] | undefined,
  pending: PendingRequests,
): PendingPart[] {
  const placed = new Set<string>();
  for (const m of messages ?? [])
    for (const p of m.parts as AnyPart[]) if (isPendingPart(p)) placed.add(p.requestId);
  const out: PendingPart[] = [];
  for (const a of pending.approvals)
    if (!placed.has(a.requestId))
      out.push({
        type: "approval",
        requestId: a.requestId,
        tool: a.tool,
        input: a.input,
        summary: a.summary,
        decision: "pending",
      });
  for (const i of pending.inputs)
    if (!placed.has(i.requestId))
      out.push({
        type: "question",
        requestId: i.requestId,
        question: i.question,
        ...(i.options ? { options: i.options } : {}),
        answer: null,
      });
  return out;
}

/** Marks a request resolved wherever it appears in a message list (the optimistic update). */
export function resolveInMessages(
  messages: readonly Message[],
  requestId: string,
  outcome: { decision: ApprovalDecision; by?: ApprovalPart["by"] } | { answer: string },
): Message[] {
  let touched = false;
  const next = messages.map((m) => {
    const parts = (m.parts as AnyPart[]).map((p): AnyPart => {
      if (!isPendingPart(p) || p.requestId !== requestId) return p;
      touched = true;
      if (p.type === "approval" && "decision" in outcome)
        return { ...p, decision: outcome.decision, ...(outcome.by ? { by: outcome.by } : {}) };
      if (p.type === "question" && "answer" in outcome) return { ...p, answer: outcome.answer };
      return p;
    });
    return touched ? { ...m, parts: parts as MessagePart[] } : m;
  });
  return touched ? next : [...messages];
}

/** Drops a request from a `pending` block once it has been answered. */
export function withoutRequest(pending: PendingRequests, requestId: string): PendingRequests {
  return {
    approvals: pending.approvals.filter((a) => a.requestId !== requestId),
    inputs: pending.inputs.filter((i) => i.requestId !== requestId),
  };
}

/** `mcp__fabdesk__render_board` → `render_board`; what the agent calls a tool is not the point. */
export function bareToolName(name: string): string {
  return name.replace(/^mcp__[^_]+__/, "").replace(/^[a-z0-9-]+__/i, "");
}

/** What a resolved approval card says under the tool name. */
export function decisionLabel(part: Pick<ApprovalPart, "decision" | "by">): string | null {
  if (part.decision === "pending") return null;
  const verb = part.decision === "approve" ? "✓ approved" : "✗ denied";
  const by =
    part.by === "desktop"
      ? " on desktop"
      : part.by === "device"
        ? " on this phone"
        : part.by === "timeout"
          ? " (timed out)"
          : "";
  return `${verb}${by}`;
}

/** A tool's input as one line for the card's collapsed state; the summary wins when it says more. */
export function inputPreview(input: unknown, max = 200): string {
  if (input === null || input === undefined) return "";
  let text: string;
  if (typeof input === "string") text = input;
  else {
    try {
      text = JSON.stringify(input);
    } catch {
      text = String(input);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The expanded card's input: pretty JSON, or the string itself. */
export function inputDetail(input: unknown, max = 4000): string {
  if (input === null || input === undefined) return "";
  const text = typeof input === "string" ? input : safeJson(input);
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** A free-text answer, cleaned; null when there is nothing to send. */
export function cleanAnswer(raw: string): string | null {
  const text = raw.trim();
  return text ? text : null;
}
