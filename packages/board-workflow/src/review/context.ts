/** What a review run holds while its checks run: the project, its design hash, the kicad-cli and the shared readings. */
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { readBoard, type Board } from "../board";
import { parseSexpr, type SNode } from "../sexpr";
import { readRequirements } from "../onboard";
import type { Acceptance, Requirements } from "../requirements";
import { boardHome, designHash, exists, type ProjectFiles } from "../files";
import { boardParts, type Part } from "./geometry";
import type { Comp } from "./netlist";
import type { CheckResult, ReviewConfig } from "./types";
import { createHash } from "node:crypto";

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BomRecord {
  line: string;
  refs: string[] | string;
  value?: string;
  status?: string;
  reason?: string;
  risks?: unknown[];
  owner?: unknown[];
  evidence?: string[];
  checks?: { datasheet?: string; description?: string };
}

/** The release stage's BOM decisions (bomcheck's `bom-decisions.json`), as the review reads them. */
export interface BomDecisions {
  records: BomRecord[];
  lines?: number;
  placements?: number;
  summary?: unknown;
}

export interface InterconnectVerdict {
  state: string;
  blocked: Array<{ id: string; body: string }>;
  text: string;
}

/** Everything outside the review's own files: kicad-cli and the optional hooks other stages (or a host) provide. */
export interface ReviewEnv {
  /** Run kicad-cli with these arguments; a non-zero exit is a result, not a throw. */
  kicad(args: string[]): Promise<CliResult>;
  kicadVersion: string;
  /** The BOM decisions for this design (release stage), or null when none exist. */
  bom?(ctx: ReviewCtx): Promise<BomDecisions | null>;
  /** The interconnect release gate. A standalone project has none (contract hook; default: none). */
  interconnect?(ctx: ReviewCtx): Promise<InterconnectVerdict | null>;
  /** Run checks.d / review.custom shell commands. Off by default: a project's data file must not run code unasked. */
  trustCustom?: boolean;
  signal?: AbortSignal;
}

export interface ReviewProject {
  dir: string;
  stem: string;
  name: string;
  pcb: string;
  sch: string;
  cfg: ReviewConfig;
  files: ProjectFiles;
}

export const reviewHome = (dir: string) => join(boardHome(dir), "review");

export class ReviewCtx {
  hash = "";
  files: Record<string, string> = {};
  comps: Map<string, Comp> | null = null;
  /** Path of this run's DRC report, once the drc check has run. */
  drc: string | null = null;
  bom: BomDecisions | null = null;
  oraclePins: Record<string, number> = {};
  cardsMatched: Map<string, Array<[string, string]>> = new Map();
  impedanceRows: Array<[string, string, number, number | null]> = [];
  results: CheckResult[] = [];
  pcbText = "";
  root!: SNode;
  board!: Board;
  requirements: Requirements | null = null;
  acceptance: Acceptance | null = null;
  private _parts: Part[] | null = null;

  constructor(
    readonly project: ReviewProject,
    readonly out: string,
    readonly offline: boolean,
    readonly env: ReviewEnv,
  ) {}

  async load(): Promise<void> {
    this.pcbText = await readFile(this.project.pcb, "utf8");
    this.root = parseSexpr(this.pcbText);
    this.board = readBoard(this.root);
    this.requirements = await readRequirements(this.project.dir);
    this.acceptance = this.requirements?.acceptance ?? null;
  }

  parts(): Part[] {
    return (this._parts ??= boardParts(this.root));
  }

  findingsSoFar() {
    return this.results.flatMap((r) => r.findings);
  }
}

/** The one design hash: board, schematics, project files, rule files and requirements, plus `review.hash_extra` files. */
export async function reviewHash(project: ReviewProject): Promise<{ hash: string; files: Record<string, string> }> {
  const d = await designHash(project.dir);
  const extra = project.cfg.hash_extra ?? [];
  const files = { ...d.files };
  const reqDir = join(boardHome(project.dir), "requirements");
  if (await exists(reqDir))
    for (const n of (await readdir(reqDir)).filter((x) => x.endsWith(".json") && !x.startsWith("~")).sort())
      files[`.fabdesk/board/requirements/${n}`] = createHash("sha256").update(await readFile(join(reqDir, n))).digest("hex");
  for (const rel of extra) {
    const p = rel.startsWith("/") ? rel : join(project.dir, rel);
    files[rel] = (await exists(p)) ? createHash("sha256").update(await readFile(p)).digest("hex") : "MISSING";
  }
  if (!extra.length) return { hash: d.design, files: { ...files } };
  return { hash: createHash("sha256").update(d.design + JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))))).digest("hex"), files };
}
