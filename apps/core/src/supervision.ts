/**
 * Supervised runtime mode: which tool calls pause for a human, and how they are described.
 * Pure — the run manager owns the pending requests, the events and the timeout.
 */
import type { ToolAnnotations } from "@fabdesk/tools";

/** Agent-native tools that write: shells and file edits. Always paused in supervised mode. */
const NATIVE_WRITES = new Set([
  // Claude Code
  "Bash",
  "PowerShell",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  // Codex (`codex exec --json` item types and app-server tool names)
  "shell",
  "shell_command",
  "apply_patch",
  "command_execution",
  "file_change",
  // Cursor / grok
  "run_terminal_cmd",
  "write_file",
  "edit_file",
  "delete_file",
]);

/**
 * Agent-native tools that read or only touch the agent's own state. Never paused. Claude Code's
 * `manual` mode auto-allows most of these without asking the prompt tool; the list matters for
 * the ones it still asks about (WebFetch, WebSearch) and for adapters that ask about everything.
 */
const NATIVE_READS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "TodoRead",
  "Task",
  "Agent",
  "Skill",
  "ToolSearch",
  "BashOutput",
  "Monitor",
  "KillShell",
  "TaskStop",
  "ExitPlanMode",
  "EnterPlanMode",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "SlashCommand",
  "web_search",
  "read_file",
  "list_dir",
  "codebase_search",
]);

export type ToolClassification = {
  needsApproval: boolean;
  /** One line for a notification: `Bash: rm -rf build`, `Write src/main.ts`, `app_click …`. */
  summary: string;
  /** Why, for logs and the timeline card. */
  reason:
    | "native-write"
    | "native-read"
    | "annotated-read"
    | "annotated-idempotent"
    | "annotated-write"
    | "unknown";
};

/** `mcp__<server>__<tool>` → `{ server, tool }`; anything else is a native tool. */
export function splitMcpName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const i = rest.indexOf("__");
  if (i <= 0 || i + 2 >= rest.length) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

/**
 * The contract: reads never pause; agent-native shells and file edits always do; an MCP tool
 * runs unattended when its annotations say it is read-only or idempotent (`project_write_file`,
 * `route_run`, `export_*`, `render_*` all qualify), and pauses otherwise (`app_click`,
 * `app_send_message`, a tool from a server the daemon knows nothing about).
 */
export function classifyToolCall(
  name: string,
  input: unknown,
  annotationsFor: (toolName: string, server: string | null) => ToolAnnotations | undefined,
): ToolClassification {
  const summary = summarizeToolCall(name, input);
  const mcp = splitMcpName(name);
  if (!mcp) {
    if (NATIVE_WRITES.has(name)) return { needsApproval: true, summary, reason: "native-write" };
    if (NATIVE_READS.has(name)) return { needsApproval: false, summary, reason: "native-read" };
    const ann = annotationsFor(name, null);
    if (ann) return fromAnnotations(ann, summary);
    return { needsApproval: true, summary, reason: "unknown" };
  }
  const ann = annotationsFor(mcp.tool, mcp.server);
  if (!ann) return { needsApproval: true, summary, reason: "unknown" };
  return fromAnnotations(ann, summary);
}

function fromAnnotations(ann: ToolAnnotations, summary: string): ToolClassification {
  if (ann.readOnlyHint === true) return { needsApproval: false, summary, reason: "annotated-read" };
  if (ann.idempotentHint === true)
    return { needsApproval: false, summary, reason: "annotated-idempotent" };
  return { needsApproval: true, summary, reason: "annotated-write" };
}

const SUMMARY_MAX = 140;

/** One line, no newlines, capped — what a lock-screen notification can show. */
export function summarizeToolCall(name: string, input: unknown): string {
  const mcp = splitMcpName(name);
  const label = mcp ? mcp.tool : name;
  const obj = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const str = (k: string): string | null =>
    typeof obj[k] === "string" && (obj[k] as string).trim() ? (obj[k] as string) : null;
  let detail: string | null = null;
  let sep = " ";
  switch (label) {
    case "Bash":
    case "PowerShell":
    case "shell":
    case "shell_command":
    case "run_terminal_cmd":
    case "command_execution":
      detail =
        str("command") ??
        str("cmd") ??
        (Array.isArray(obj["command"])
          ? (obj["command"] as unknown[]).map(String).join(" ")
          : null);
      sep = ": ";
      break;
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "write_file":
    case "edit_file":
    case "delete_file":
      detail = str("file_path") ?? str("path");
      break;
    case "NotebookEdit":
      detail = str("notebook_path");
      break;
    case "apply_patch":
    case "file_change":
      detail = Array.isArray(obj["changes"])
        ? `${(obj["changes"] as unknown[]).length} file(s)`
        : (str("patch") ?? null);
      break;
    default:
      detail = str("path") ?? str("file") ?? str("command") ?? compactJson(input);
  }
  return oneLine(detail ? `${label}${sep}${detail}` : label);
}

function compactJson(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "object" && Object.keys(v as object).length === 0) return null;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > SUMMARY_MAX ? `${flat.slice(0, SUMMARY_MAX - 1)}…` : flat;
}

/** Claude Code's `AskUserQuestion` input; the prompt tool answers it through `updatedInput.answers`. */
export type AskUserQuestionInput = {
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
};

export function parseAskUserQuestion(input: unknown): AskUserQuestionInput["questions"] | null {
  if (typeof input !== "object" || input === null) return null;
  const qs = (input as { questions?: unknown }).questions;
  if (!Array.isArray(qs)) return null;
  const out: AskUserQuestionInput["questions"] = [];
  for (const q of qs) {
    if (typeof q !== "object" || q === null) continue;
    const rec = q as Record<string, unknown>;
    if (typeof rec["question"] !== "string") continue;
    const options = Array.isArray(rec["options"])
      ? (rec["options"] as unknown[]).flatMap((o) =>
          typeof o === "object" &&
          o !== null &&
          typeof (o as { label?: unknown }).label === "string"
            ? [{ label: (o as { label: string }).label }]
            : [],
        )
      : undefined;
    out.push({ question: rec["question"], ...(options && options.length ? { options } : {}) });
  }
  return out.length ? out : null;
}
