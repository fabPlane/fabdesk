/** Helpers shared by tool handlers. */
import { join } from "node:path";
import { NetlistFile, ProjectPartsFile, emptyProjectParts } from "@fabdesk/protocol";
import { PROJECT_FILES, exists, readJsonIfPresent, readJsonOrNull, writeJson } from "../fs";
import { ToolError, type ProjectHandle, type ToolContext, type ToolOutput } from "../registry";
import type { KicadCli, SchematicHierarchy } from "../services";

export function p(project: ProjectHandle, ...parts: string[]): string {
  return join(project.dir, ...parts);
}

export function fileUrl(path: string): string {
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The project's design source, `circuit.netlist.json`, checked against the schema. */
export async function loadNetlist(project: ProjectHandle): Promise<NetlistFile> {
  const path = p(project, PROJECT_FILES.netlistJson);
  const raw = await readJsonOrNull<unknown>(path);
  if (raw === null) throw new ToolError(`${PROJECT_FILES.netlistJson} not found`, "precondition");
  const parsed = NetlistFile.safeParse(raw);
  if (!parsed.success)
    throw new ToolError(
      `${PROJECT_FILES.netlistJson} is not a valid netlist: ${parsed.error.issues.map((i) => `${i.path.join("/")}: ${i.message}`).join("; ")}`,
      "precondition",
    );
  return parsed.data;
}

export async function loadNetlistOrNull(project: ProjectHandle): Promise<NetlistFile | null> {
  const path = p(project, PROJECT_FILES.netlistJson);
  const raw = await readJsonOrNull<unknown>(path);
  if (raw === null) return null;
  const parsed = NetlistFile.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Off-board parts file; missing file is an empty list. Invalid JSON / unreadable file is a precondition error. */
export async function loadProjectParts(project: ProjectHandle): Promise<ProjectPartsFile> {
  const path = p(project, PROJECT_FILES.projectParts);
  let raw: unknown;
  try {
    raw = await readJsonIfPresent<unknown>(path);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new ToolError(`${PROJECT_FILES.projectParts} is not valid JSON: ${msg}`, "precondition");
  }
  if (raw === null) return emptyProjectParts();
  const parsed = ProjectPartsFile.safeParse(raw);
  if (!parsed.success)
    throw new ToolError(
      `${PROJECT_FILES.projectParts} is not valid: ${parsed.error.issues.map((i) => `${i.path.join("/")}: ${i.message}`).join("; ")}`,
      "precondition",
    );
  return parsed.data;
}

export async function saveProjectParts(project: ProjectHandle, file: ProjectPartsFile): Promise<void> {
  await writeJson(p(project, PROJECT_FILES.projectParts), file);
}

export async function requireKicad(ctx: ToolContext): Promise<KicadCli> {
  const cli = await ctx.services.kicad.resolveCli();
  if (!cli) {
    throw new ToolError(
      "kicad-cli not found. The FabPlane KiCad fork should ship with the app; reinstall fabPlane, or set Settings.kicadCliPath / KICAD_CLI to override. Verify, render and export tools need it.",
      "unavailable",
    );
  }
  return cli;
}

export async function findBoard(project: ProjectHandle): Promise<string | null> {
  const board = p(project, PROJECT_FILES.boardPcb);
  return (await exists(board)) ? board : null;
}

export async function requireBoard(project: ProjectHandle): Promise<string> {
  const board = await findBoard(project);
  if (!board) throw new ToolError("board.kicad_pcb not found", "precondition");
  return board;
}

export async function requireSchematic(project: ProjectHandle): Promise<string> {
  const sch = p(project, PROJECT_FILES.boardSch);
  if (!(await exists(sch))) throw new ToolError("board.kicad_sch not found", "precondition");
  return sch;
}

export async function inspectSavedHierarchy(
  ctx: ToolContext,
  project: ProjectHandle,
  cli?: KicadCli,
): Promise<SchematicHierarchy> {
  const packagedCli = cli ?? (await requireKicad(ctx));
  const schematic = await requireSchematic(project);
  const projectFile = p(project, PROJECT_FILES.boardPro);
  return ctx.services.kicad.inspectSchematicHierarchy(packagedCli, {
    projectDir: project.dir,
    rootSchematic: schematic,
    ...((await exists(projectFile)) ? { projectFile } : {}),
    signal: ctx.signal,
  });
}

export function compactHierarchy(hierarchy: SchematicHierarchy, offset = 0, limit = 25) {
  const sheets = hierarchy.sheets.slice(offset, offset + limit);
  return {
    ...hierarchy,
    sheets,
    pagination: {
      offset,
      limit,
      returned: sheets.length,
      total: hierarchy.sheets.length,
      truncated: offset + sheets.length < hierarchy.sheets.length,
      ...(offset + sheets.length < hierarchy.sheets.length
        ? { nextOffset: offset + sheets.length }
        : {}),
    },
  };
}

export async function writeReport(
  project: ProjectHandle,
  name: string,
  value: unknown,
): Promise<string> {
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
  const cell = (v: unknown) =>
    v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  const lines = [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`];
  for (const r of rows)
    lines.push(`| ${cols.map((c) => cell(r[c]).replace(/\|/g, "\\|")).join(" | ")} |`);
  return lines.join("\n");
}

export function trim(s: string, max = 20_000): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars truncated)` : s;
}
