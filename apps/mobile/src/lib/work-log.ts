/**
 * What an assistant turn actually did to the project, read off its tool calls: files written,
 * renders, exports, route runs. The tool cards carry the same data; this is the one-line
 * summary under the turn for when you do not want to open them. Pure, Bun-tested.
 */
import type { MessagePart } from "@fabdesk/protocol";
import { bareToolName } from "./pending-requests";

export interface WorkLog {
  filesWritten: string[];
  renders: number;
  exports: string[];
  routeRuns: number;
  toolCalls: number;
  errors: number;
}

const EMPTY: WorkLog = {
  filesWritten: [],
  renders: 0,
  exports: [],
  routeRuns: 0,
  toolCalls: 0,
  errors: 0,
};

/** Agent-native editors: Claude Code's Write/Edit/NotebookEdit; Codex's apply_patch. */
const FILE_TOOLS: Record<string, (input: Record<string, unknown>) => string[]> = {
  project_write_file: (i) => str(i["path"]),
  project_import_kicad: (i) => str(i["path"]),
  write: (i) => str(i["file_path"]),
  edit: (i) => str(i["file_path"]),
  multiedit: (i) => str(i["file_path"]),
  notebookedit: (i) => str(i["notebook_path"]),
  apply_patch: (i) => patchedFiles(i["patch"] ?? i["input"]),
};

function str(v: unknown): string[] {
  return typeof v === "string" && v ? [v] : [];
}

/** `*** Add File: x` / `*** Update File: x` / `*** Delete File: x` lines of a Codex patch. */
function patchedFiles(patch: unknown): string[] {
  if (typeof patch !== "string") return [];
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    const path = m[1]?.trim();
    if (path) out.push(path);
  }
  return out;
}

export function workLog(parts: readonly MessagePart[]): WorkLog {
  const log: WorkLog = { ...EMPTY, filesWritten: [], exports: [] };
  const files = new Set<string>();
  const exports = new Set<string>();
  for (const p of parts) {
    if (p.type === "tool_result") {
      if (p.isError) log.errors++;
      continue;
    }
    if (p.type !== "tool_use") continue;
    log.toolCalls++;
    const name = bareToolName(p.name);
    const input = (p.input && typeof p.input === "object" ? p.input : {}) as Record<
      string,
      unknown
    >;
    const filesOf = FILE_TOOLS[name.toLowerCase()];
    if (filesOf) for (const f of filesOf(input)) files.add(f);
    else if (name.startsWith("render_")) log.renders++;
    else if (name.startsWith("export_")) exports.add(name.slice("export_".length));
    else if (name === "route_run") log.routeRuns++;
  }
  log.filesWritten = [...files];
  log.exports = [...exports];
  return log;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 files · 1 render · 1 export", or the tool-call count when nothing notable happened; null when no tools ran. */
export function workLogLabel(log: WorkLog): string | null {
  if (log.toolCalls === 0 && log.errors === 0) return null;
  const bits: string[] = [];
  if (log.filesWritten.length) bits.push(plural(log.filesWritten.length, "file"));
  if (log.renders) bits.push(plural(log.renders, "render"));
  if (log.exports.length) bits.push(plural(log.exports.length, "export"));
  if (log.routeRuns) bits.push(plural(log.routeRuns, "route run"));
  if (bits.length === 0) bits.push(plural(log.toolCalls, "tool call"));
  if (log.errors) bits.push(`${log.errors} failed`);
  return bits.join(" · ");
}

/** The expanded lines: every file and export by name; nothing when the label already said it all. */
export function workLogDetails(log: WorkLog): string[] {
  const lines: string[] = [];
  for (const f of log.filesWritten) lines.push(`wrote ${f}`);
  for (const e of log.exports) lines.push(`exported ${e}`);
  return lines;
}
