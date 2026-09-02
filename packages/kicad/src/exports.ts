import { mkdir, readdir, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { runKicadCli, type KicadCli } from "./cli";

type Paths = { paths: string[] };

async function filesWrittenSince(dir: string, since: number, ext?: RegExp): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    if (ext && !ext.test(name)) continue;
    const abs = join(dir, name);
    const info = await stat(abs);
    if (info.isFile() && info.mtimeMs >= since - 1000) out.push(abs);
  }
  return out.sort();
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Gerbers for every enabled layer (plus edge cuts) into `outDir`. */
export async function exportGerbers(cli: KicadCli, opts: { board: string; outDir: string; signal?: AbortSignal }): Promise<Paths> {
  await ensureDir(opts.outDir);
  const started = Date.now();
  await runKicadCli(cli, ["pcb", "export", "gerbers", "-o", withTrailingSep(opts.outDir), opts.board], sig(opts));
  return { paths: await filesWrittenSince(opts.outDir, started, /\.(g[a-z0-9]+|gbr|gbrjob)$/i) };
}

/** Excellon drill files (PTH/NPTH merged) into `outDir`. */
export async function exportDrill(cli: KicadCli, opts: { board: string; outDir: string; signal?: AbortSignal }): Promise<Paths> {
  await ensureDir(opts.outDir);
  const started = Date.now();
  await runKicadCli(cli, ["pcb", "export", "drill", "--format", "excellon", "-o", withTrailingSep(opts.outDir), opts.board], sig(opts));
  return { paths: await filesWrittenSince(opts.outDir, started, /\.(drl|xln|txt)$/i) };
}

/** Pick-and-place CSV (both sides, mm). */
export async function exportPos(cli: KicadCli, opts: { board: string; output: string; signal?: AbortSignal }): Promise<Paths> {
  await runKicadCli(cli, ["pcb", "export", "pos", "--format", "csv", "--units", "mm", "--side", "both", "-o", opts.output, opts.board], sig(opts));
  return { paths: [opts.output] };
}

/** Grouped BOM CSV from the schematic. */
export async function exportBom(cli: KicadCli, opts: { schematic: string; output: string; signal?: AbortSignal }): Promise<Paths> {
  await runKicadCli(cli, ["sch", "export", "bom", "-o", opts.output, opts.schematic], sig(opts));
  return { paths: [opts.output] };
}

export async function exportNetlist(
  cli: KicadCli,
  opts: { schematic: string; output: string; format: "kicadsexpr" | "spice"; signal?: AbortSignal },
): Promise<Paths> {
  await runKicadCli(cli, ["sch", "export", "netlist", "--format", opts.format, "-o", opts.output, opts.schematic], sig(opts));
  return { paths: [opts.output] };
}

/** One SVG per schematic sheet into `outDir`. */
export async function exportSchematicSvg(cli: KicadCli, opts: { schematic: string; outDir: string; signal?: AbortSignal }): Promise<Paths> {
  await ensureDir(opts.outDir);
  const started = Date.now();
  await runKicadCli(cli, ["sch", "export", "svg", "-o", withTrailingSep(opts.outDir), opts.schematic], sig(opts));
  return { paths: await filesWrittenSince(opts.outDir, started, /\.svg$/i) };
}

function withTrailingSep(dir: string): string {
  return dir.endsWith(sep) ? dir : dir + sep;
}

function sig(opts: { signal?: AbortSignal }): { signal?: AbortSignal } {
  return opts.signal ? { signal: opts.signal } : {};
}
