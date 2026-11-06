import { extractBoardFeatures } from "./board-features";
import { cropNativePageSvg } from "./pcb-svg-coordinates";
import { frameSchematicCircuit } from "./raster";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
export async function exportGerbers(
  cli: KicadCli,
  opts: { board: string; outDir: string; signal?: AbortSignal },
): Promise<Paths> {
  await ensureDir(opts.outDir);
  const started = Date.now();
  await runKicadCli(
    cli,
    ["pcb", "export", "gerbers", "-o", withTrailingSep(opts.outDir), opts.board],
    sig(opts),
  );
  return { paths: await filesWrittenSince(opts.outDir, started, /\.(g[a-z0-9]+|gbr|gbrjob)$/i) };
}

/**
 * One DXF per layer into `outDir` (mm units, actual drill shapes). This is the copper-removal artwork for
 * prefab blanks such as Viagrid: LightBurn imports the DXF, the laser ablates the copper outside the drawn
 * traces and pads. kicad-cli cannot mirror, so the bottom layer is exported as seen from the top and must be
 * mirrored in the laser software (LightBurn: Arrange → Flip Horizontal) before burning.
 */
export async function exportDxf(
  cli: KicadCli,
  opts: { board: string; outDir: string; layers: string[]; signal?: AbortSignal },
): Promise<Paths> {
  await ensureDir(opts.outDir);
  const started = Date.now();
  await runKicadCli(
    cli,
    [
      "pcb",
      "export",
      "dxf",
      "--output-units",
      "mm",
      "--mode-multi",
      "--layers",
      opts.layers.join(","),
      "-o",
      withTrailingSep(opts.outDir),
      opts.board,
    ],
    sig(opts),
  );
  return { paths: await filesWrittenSince(opts.outDir, started, /\.dxf$/i) };
}

/** Excellon drill files (PTH/NPTH merged) into `outDir`. */
export async function exportDrill(
  cli: KicadCli,
  opts: { board: string; outDir: string; signal?: AbortSignal },
): Promise<Paths> {
  await ensureDir(opts.outDir);
  const started = Date.now();
  await runKicadCli(
    cli,
    [
      "pcb",
      "export",
      "drill",
      "--format",
      "excellon",
      "-o",
      withTrailingSep(opts.outDir),
      opts.board,
    ],
    sig(opts),
  );
  return { paths: await filesWrittenSince(opts.outDir, started, /\.(drl|xln|txt)$/i) };
}

/** Pick-and-place CSV (both sides, mm). */
export async function exportPos(
  cli: KicadCli,
  opts: { board: string; output: string; signal?: AbortSignal },
): Promise<Paths> {
  await runKicadCli(
    cli,
    [
      "pcb",
      "export",
      "pos",
      "--format",
      "csv",
      "--units",
      "mm",
      "--side",
      "both",
      "-o",
      opts.output,
      opts.board,
    ],
    sig(opts),
  );
  return { paths: [opts.output] };
}

/** Grouped BOM CSV from the schematic. */
export async function exportBom(
  cli: KicadCli,
  opts: { schematic: string; output: string; signal?: AbortSignal },
): Promise<Paths> {
  await runKicadCli(cli, ["sch", "export", "bom", "-o", opts.output, opts.schematic], sig(opts));
  return { paths: [opts.output] };
}

export async function exportNetlist(
  cli: KicadCli,
  opts: { schematic: string; output: string; format: "kicadsexpr" | "spice"; signal?: AbortSignal },
): Promise<Paths> {
  await runKicadCli(
    cli,
    ["sch", "export", "netlist", "--format", opts.format, "-o", opts.output, opts.schematic],
    sig(opts),
  );
  return { paths: [opts.output] };
}

/** One SVG per schematic sheet into `outDir`. */
export async function exportSchematicSvg(
  cli: KicadCli,
  opts: { schematic: string; outDir: string; pages?: number[]; circuit?: boolean; signal?: AbortSignal },
): Promise<Paths> {
  if (opts.pages && (!opts.pages.length || opts.pages.some(page => !Number.isSafeInteger(page) || page < 1))) throw new Error("Schematic pages must be positive integers");
  await ensureDir(opts.outDir);
  const started = Date.now();
  await runKicadCli(
    cli,
    ["sch", "export", "svg", ...(opts.pages ? ["--pages", opts.pages.join(",")] : []), ...(opts.circuit ? ["--exclude-drawing-sheet", "--no-background-color"] : []), "-o", withTrailingSep(opts.outDir), opts.schematic],
    sig(opts),
  );
  const paths = await filesWrittenSince(opts.outDir, started, /\.svg$/i);
  if (opts.circuit) for (const path of paths) await writeFile(path, await frameSchematicCircuit(await readFile(path, "utf8")));
  return { paths };
}

/** Multi-sheet schematic PDF suitable for the release handoff. */
export async function exportSchematicPdf(
  cli: KicadCli,
  opts: { schematic: string; output: string; signal?: AbortSignal },
): Promise<Paths> {
  await runKicadCli(cli, ["sch", "export", "pdf", "-o", opts.output, opts.schematic], sig(opts));
  return { paths: [opts.output] };
}

/** The board as one SVG: the given layers (default copper, silkscreen and edge cuts), page-sized. */
export async function exportPcbSvg(
  cli: KicadCli,
  opts: { board: string; output: string; layers?: string[]; signal?: AbortSignal },
): Promise<Paths> {
  const layers = opts.layers ?? ["F.Cu", "B.Cu", "F.SilkS", "B.SilkS", "Edge.Cuts"];
  // Current-page mode preserves native coordinates. Crop only the viewport afterward.
  await runKicadCli(
    cli,
    [
      "pcb",
      "export",
      "svg",
      "--layers",
      layers.join(","),
      "--exclude-drawing-sheet",
      "--page-size-mode",
      "1",
      "--mode-single",
      "-o",
      opts.output,
      opts.board,
    ],
    sig(opts),
  );
  let bounds: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
  try { bounds = extractBoardFeatures(await readFile(opts.board, "utf8")).outline; }
  catch { /* Boards without a usable outline retain their native current-page viewport. */ }
  await writeFile(opts.output, cropNativePageSvg(await readFile(opts.output, "utf8"), bounds));
  return { paths: [opts.output] };
}

function withTrailingSep(dir: string): string {
  return dir.endsWith(sep) ? dir : dir + sep;
}

function sig(opts: { signal?: AbortSignal }): { signal?: AbortSignal } {
  return opts.signal ? { signal: opts.signal } : {};
}
