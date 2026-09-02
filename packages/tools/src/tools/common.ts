/** Helpers shared by tool handlers. */
import { join } from "node:path";
import { PROJECT_FILES, exists, mtimeMs, readJsonOrNull, writeJson } from "../fs";
import { ToolError, type ProjectHandle, type ToolContext, type ToolOutput } from "../registry";
import type { CircuitJson, KicadCli } from "../services";

export function p(project: ProjectHandle, ...parts: string[]): string {
  return join(project.dir, ...parts);
}

/** Prefer `circuit.routed.json` when it is newer than `circuit.json`. */
export async function loadCircuitJson(
  project: ProjectHandle,
  opts: { preferRouted?: boolean } = {},
): Promise<{ circuitJson: CircuitJson; source: "circuit.json" | "circuit.routed.json" }> {
  const built = p(project, PROJECT_FILES.circuitJson);
  const routed = p(project, PROJECT_FILES.routedJson);
  const [bm, rm] = await Promise.all([mtimeMs(built), mtimeMs(routed)]);
  if ((opts.preferRouted ?? true) && rm !== null && (bm === null || rm >= bm)) {
    const cj = await readJsonOrNull<CircuitJson>(routed);
    if (cj) return { circuitJson: cj, source: "circuit.routed.json" };
  }
  const cj = await readJsonOrNull<CircuitJson>(built);
  if (!cj) throw new ToolError("circuit.json not found: run circuit_build first", "precondition");
  return { circuitJson: cj, source: "circuit.json" };
}

export async function requireKicad(ctx: ToolContext): Promise<KicadCli> {
  const cli = await ctx.services.kicad.resolveCli();
  if (!cli) {
    throw new ToolError(
      "kicad-cli not found. Install KiCad 9/10 or set Settings.kicadCliPath / KICAD_CLI; kicad, verify, render and export tools need it.",
      "unavailable",
    );
  }
  return cli;
}

export async function requireBoard(project: ProjectHandle): Promise<string> {
  const board = p(project, PROJECT_FILES.boardPcb);
  if (!(await exists(board))) throw new ToolError("board.kicad_pcb not found: run kicad_convert first", "precondition");
  return board;
}

export async function requireSchematic(project: ProjectHandle): Promise<string> {
  const sch = p(project, PROJECT_FILES.boardSch);
  if (!(await exists(sch))) throw new ToolError("board.kicad_sch not found: run kicad_convert first", "precondition");
  return sch;
}

export async function writeReport(project: ProjectHandle, name: string, value: unknown): Promise<string> {
  const path = p(project, PROJECT_FILES.reports, `${name}.json`);
  await writeJson(path, value);
  return path;
}

export function ok(text: string, json?: unknown, extra: Partial<ToolOutput> = {}): ToolOutput {
  return { text, ...(json !== undefined ? { json } : {}), ...extra };
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError("cancelled", "cancelled");
}

export function countBy<T>(items: T[], key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const k = key(it);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Compact markdown table for LLM consumption. */
export function table(rows: Array<Record<string, unknown>>, columns?: string[]): string {
  if (rows.length === 0) return "(none)";
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
  const lines = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`];
  for (const r of rows) lines.push(`| ${cols.map((c) => cell(r[c]).replace(/\|/g, "\\|")).join(" | ")} |`);
  return lines.join("\n");
}

export function trim(s: string, max = 20_000): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars truncated)` : s;
}
