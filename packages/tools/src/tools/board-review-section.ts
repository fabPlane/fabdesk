/**
 * board_review's impedance-proof actions (they read no board and never touch the review record):
 *
 * - `section`: a finite-difference 2D cross section through atlc (the toolkit's `review/atlc_section.py`): a pair from
 *   its geometry (`pair`: width, gap, thickness, hnear, hfar for stripline, er, top_etch, margin, mask) or any section
 *   (box, dielectric bands and polygons, conductors at +1 / 0 / -1 V). One solve per pixel size, so convergence can be
 *   read off two sizes. atlc is a board engine: installed on first use (built from source) unless one is on PATH.
 * - `short_section`: the lossless mismatched-section reflection at the edge knee (`review/short_section.py`) for a list
 *   of cases, to bound a short off-target stretch (an escape) without an eye simulation.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { boardHome, confineToProject, impedance, isInside, pairSection, solveSection, type SectionSpec } from "@fabdesk/board-workflow";
import { ToolError, type ToolContext, type ToolOutput } from "../registry";
import { ok } from "./common";

type SpecInput = Record<string, unknown> | string | undefined;

async function readSpec(dir: string, spec: SpecInput, what: string): Promise<Record<string, unknown>> {
  if (spec === undefined) throw new ToolError(`${what} needs spec`, "invalid_args");
  let raw: unknown = spec;
  if (typeof spec === "string") {
    const t = spec.trim();
    try {
      raw = t.startsWith("{") ? JSON.parse(t) : JSON.parse(await readFile(await confineToProject(dir, t, "spec file"), "utf8"));
    } catch (e) {
      throw new ToolError(`cannot read the spec: ${e instanceof Error ? e.message : String(e)}`, "invalid_args");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ToolError("spec must be a JSON object", "invalid_args");
  return raw as Record<string, unknown>;
}

function outFile(dir: string, p: string): string {
  const f = resolve(dir, p);
  if (!isInside(resolve(dir), f)) throw new ToolError(`out ${p} is outside the project`, "invalid_args");
  return f;
}

const sectionsDir = (dir: string) => resolve(boardHome(dir), "review", "sections");

/** The atlc binary: the board engines' (installed on first use), else ATLC_BIN or an atlc on PATH. */
async function atlcPath(ctx: ToolContext, note: (l: string) => void): Promise<string> {
  const routers = ctx.services.routers;
  if (routers) {
    const r = await routers.ensure("atlc", { onLine: note });
    if (r.path) return r.path;
    throw new ToolError(r.why ?? "atlc is not installed", "precondition");
  }
  const own = process.env["ATLC_BIN"]?.trim() || Bun.which("atlc");
  if (!own) throw new ToolError("atlc is not installed: install your system's atlc package or set ATLC_BIN", "precondition");
  return own;
}

export async function sectionAction(ctx: ToolContext, dir: string, input: { spec?: SpecInput; pixelMm?: number[] | undefined; out?: string | undefined }, note: (l: string) => void): Promise<ToolOutput> {
  const raw = await readSpec(dir, input.spec, "section");
  let spec: SectionSpec;
  try {
    spec = raw["pair"] ? pairSection(raw["pair"] as Parameters<typeof pairSection>[0]) : (raw as unknown as SectionSpec);
  } catch (e) {
    throw new ToolError(e instanceof Error ? e.message : String(e), "invalid_args");
  }
  if (!Array.isArray(spec.box) || spec.box.length !== 4 || !Array.isArray(spec.conductors) || !spec.conductors.length)
    throw new ToolError("spec needs box [xmin, ymin, xmax, ymax] and conductors (or pair: {width, gap, thickness, hnear, ...})", "invalid_args");
  const pixels = input.pixelMm?.length ? input.pixelMm : [0.004];
  const stem = input.out ? outFile(dir, input.out) : resolve(sectionsDir(dir), "section");
  const atlc = await atlcPath(ctx, note);
  const lines: string[] = [];
  const runs = [];
  for (const px of pixels) {
    ctx.signal?.throwIfAborted();
    const out = `${stem.replace(/\.json$/, "")}-${Math.round(px * 1000 * 1000) / 1000}um`;
    note(`atlc: solving at ${px * 1000} um pixels`);
    try {
      const r = await solveSection(spec, out, atlc, { pixelMm: px, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      const m = r.metrics;
      lines.push(`${px * 1000} um (${r.grid.join(" x ")}, ${r.seconds.toFixed(1)} s): ${["Zdiff", "Zo", "Zodd", "Zeven", "Zcomm", "Er_odd", "Er_even"].filter((k) => k in m).map((k) => `${k} ${m[k]}`).join(", ")}  -> ${out}.json`);
      runs.push({ pixel_mm: px, file: `${out}.json`, metrics: m, grid: r.grid, seconds: r.seconds, bitmap_sha256: r.bitmap_sha256 });
    } catch (e) {
      throw new ToolError(`atlc failed: ${e instanceof Error ? e.message : String(e)}`, "internal");
    }
  }
  if (runs.length > 1) {
    const z = runs.map((r) => r.metrics["Zdiff"] ?? r.metrics["Zo"]).filter((v): v is number => typeof v === "number");
    if (z.length > 1) lines.push(`pixel-size spread ${(Math.max(...z) - Math.min(...z)).toFixed(3)} ohm (a nominal 2D figure, not assembled or 3D SI)`);
  }
  return ok([`atlc ${atlc}`, ...lines].join("\n"), { atlc, spec, runs });
}

export async function shortSectionAction(dir: string, input: { spec?: SpecInput; out?: string | undefined }): Promise<ToolOutput> {
  const raw = await readSpec(dir, input.spec, "short_section");
  const cases = raw["cases"];
  if (!Array.isArray(cases) || !cases.length) throw new ToolError("spec needs cases: [{name, z0, zs, er, length_mm, rise_ns}]", "invalid_args");
  for (const c of cases as Array<Record<string, unknown>>)
    for (const k of ["z0", "zs", "er", "length_mm", "rise_ns"]) if (typeof c[k] !== "number") throw new ToolError(`every case needs a number ${k}`, "invalid_args");
  const rep = impedance.shortSectionReport(raw as Parameters<typeof impedance.shortSectionReport>[0]);
  const out = input.out ? outFile(dir, input.out) : resolve(sectionsDir(dir), "short-section.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(rep, null, 2) + "\n");
  const lines = rep.rows.map((r) => `${r.name ?? "case"} ${r.delay_ps.toFixed(1)} ps, knee reflection ${r.section_reflection_at_knee.toFixed(4)} (step ${r.interface_step_reflection.toFixed(4)}, round trip ${(100 * r.round_trip_fraction_of_rise).toFixed(1)} % of rise)`);
  return ok([...lines, `-> ${out}`, "lossless, at the edge knee only: not an eye or compliance simulation"].join("\n"), rep);
}
