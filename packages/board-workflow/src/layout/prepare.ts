/**
 * Prepare a project for the layout flow: a base copy of its files with the routed copper removed and the fixed parts
 * locked, the proposed placer groups and keep-outs, and the spec that ties them to the board's requirements.
 * Lives in `<project>/.fabdesk/board/layout/`; the agent edits `groups.json` and `spec.json` there.
 */
import { copyFile, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseBoard } from "../board";
import { boardHome, locateProject, writeJsonFile } from "../files";
import { readOnboardRecord, readRequirements, requirementsDir } from "../onboard";
import { pathExists } from "./fsx";
import { pairSeat, seatGroups } from "./pairseat";
import { BUILTIN_PLAN_REFS, deriveGroups, escapeKeepouts, fixedRegex, type LayoutSpec } from "./spec";
import { lockFootprints, stripCopper } from "./text";

export const layoutDir = (projectDir: string) => join(boardHome(projectDir), "layout");

export interface PrepareResult {
  spec: LayoutSpec;
  specPath: string;
  decided: string[];
  review: string[];
}

export async function prepareLayout(projectDir: string, opts: { pcb?: string; name?: string; refresh?: boolean } = {}): Promise<PrepareResult> {
  const files = await locateProject(projectDir, opts.pcb);
  const out = layoutDir(projectDir);
  const specPath = join(out, "spec.json");
  if (!opts.refresh && (await pathExists(specPath))) return { spec: JSON.parse(await readFile(specPath, "utf8")) as LayoutSpec, specPath, decided: [], review: [] };
  const record = await readOnboardRecord(projectDir);
  if (!record) throw new Error("no onboarding record: run board_check first (it onboards the board)");
  await rm(join(out, "base"), { recursive: true, force: true });
  const base = join(out, "base");
  await mkdir(base, { recursive: true });
  const decided: string[] = [];
  const review: string[] = [];
  for (const e of await readdir(projectDir, { withFileTypes: true })) {
    const ext = /\.[^.]+$/.exec(e.name)?.[0] ?? "";
    if (e.isFile() && ([".kicad_pro", ".kicad_dru", ".kicad_sch", ".kicad_sym"].includes(ext) || ["fp-lib-table", "sym-lib-table"].includes(e.name))) await copyFile(join(projectDir, e.name), join(base, e.name));
    else if (e.isDirectory() && ext === ".pretty") await cp(join(projectDir, e.name), join(base, e.name), { recursive: true });
  }
  const sheets = (await readdir(projectDir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith(".") && !e.name.endsWith(".pretty"));
  for (const d of sheets)
    for (const n of await readdir(join(projectDir, d.name)))
      if (n.endsWith(".kicad_sch")) {
        await mkdir(join(base, d.name), { recursive: true });
        await copyFile(join(projectDir, d.name, n), join(base, d.name, n));
      }
  const text = await readFile(files.pcb, "utf8");
  const stripped = stripCopper(text);
  decided.push(`removed ${Object.values(stripped.removed).reduce((a, b) => a + b, 0)} routed items (segments/vias/arcs); zones kept for refill`);
  const fixed = record.fixed;
  await writeFile(join(base, `${files.stem}.kicad_pcb`), lockFootprints(stripped.text, fixed));
  const board = parseBoard(text);
  const keepouts = escapeKeepouts(board.pads, fixed);
  decided.push(`${keepouts.length} escape keep-outs for fine-pitch fixed rows`);
  if (!(await readdir(requirementsDir(projectDir)).catch(() => [])).length) throw new Error("requirements missing: run board_check first");
  let groups = deriveGroups(board, new Set(fixed));
  // pass-through parts of pairs seated on their chip's pins (the toolkit's flow/pairseat.py); members join the chip's group
  const req = await readRequirements(projectDir);
  const rows = req ? pairSeat(board, req.acceptance, new RegExp(fixedRegex(fixed))) : {};
  const templates: string[] = [];
  await rm(join(out, "templates"), { recursive: true, force: true });
  if (Object.keys(rows).length) {
    groups = seatGroups(groups, rows);
    for (const [chip, row] of Object.entries(rows)) {
      const f = join(out, "templates", `${chip}.row.json`);
      await writeJsonFile(f, row);
      templates.push(f);
    }
    decided.push("pair pass-through templates: " + Object.entries(rows).map(([c, r]) => `${c}: ${JSON.stringify(r.members.map((m) => m.ref))}`).join("; "));
    review.push("templates: check each pass-through row in layout/templates/ (edit or drop a member; spec.templates lists them)");
  }
  decided.push(`${groups.length} groups: ` + groups.map((g) => `${g.name}(${g.refs.length})`).join(", "));
  review.push("groups: check dense blocks; add datasheet templates for switchers and serializers (spec.templates)");
  await writeJsonFile(join(out, "groups.json"), { schema: 1, board: `${files.stem}.kicad_pcb`, groups });
  const spec: LayoutSpec = {
    name: opts.name ?? (basename(projectDir) || "board"),
    stem: files.stem,
    base,
    requirements: requirementsDir(projectDir),
    fixed: fixedRegex(fixed),
    groups: join(out, "groups.json"),
    templates,
    plans: { ...BUILTIN_PLAN_REFS },
    keepouts,
    cull_keep_fraction: 1.0,
    budgets_min: { place: 20, rank_seed: 25, tm: 20, finish: 15 },
    lastmile_max_open: 25,
  };
  await writeJsonFile(specPath, spec);
  return { spec, specPath, decided, review };
}
