// ported from fabplane packages/pcb/src/kicad-cli.ts; replace with @pcb/pcb/kicad-cli once it lands on fabplane main
import { existsSync } from "node:fs";
import { lastLines, runKicadCli, type KicadCli } from "./cli";

export type BoardView = "top" | "bottom" | "perspective" | "side";

export interface RenderPngOptions {
  board: string;
  output: string;
  view: BoardView;
  width?: number;
  height?: number;
  quality?: "basic" | "high";
  /** Camera for the perspective view, as kicad-cli `--rotate` angles and `--zoom`. */
  perspective?: { rotate: string; zoom: number };
  signal?: AbortSignal;
}

export const DEFAULT_PERSPECTIVE = { rotate: "-38,0,28", zoom: 0.72 } as const;

/** Renders one PNG of a board with the KiCad ray tracer, transparent background. */
export async function renderPng(cli: KicadCli, options: RenderPngOptions): Promise<void> {
  const width = options.width ?? 1800;
  const height = options.height ?? (options.view === "side" ? 700 : 1125);
  const args = [
    "pcb",
    "render",
    "--width",
    String(width),
    "--height",
    String(height),
    "--quality",
    options.quality ?? "high",
    "--background",
    "transparent",
    "-o",
    options.output,
  ];
  switch (options.view) {
    case "top":
      args.push("--side", "top");
      break;
    case "bottom":
      args.push("--side", "bottom");
      break;
    case "side":
      args.push("--side", "left");
      break;
    case "perspective": {
      const camera = options.perspective ?? DEFAULT_PERSPECTIVE;
      args.push("--perspective", "--rotate", camera.rotate, "--zoom", String(camera.zoom));
      break;
    }
  }
  args.push(options.board);
  await runKicadCli(cli, args, { ...(options.signal ? { signal: options.signal } : {}) });
  if (!existsSync(options.output)) throw new Error(`kicad-cli did not write ${options.output}`);
}

export interface ExportGlbOptions {
  board: string;
  output: string;
  includeDnp?: boolean;
  signal?: AbortSignal;
}

/**
 * Exports a binary glTF with substituted STEP models, pads, silkscreen and solder mask. KiCad
 * reports a failure exit code when `--fuse-shapes` hits geometry it cannot fuse even though it
 * still writes the file, so a written file is accepted; when nothing was written the export is
 * retried unfused.
 */
export async function exportGlb(cli: KicadCli, options: ExportGlbOptions): Promise<{ fused: boolean; warnings: string[] }> {
  const base = ["pcb", "export", "glb", "--force", "--subst-models", "--include-pads", "--include-silkscreen", "--include-soldermask"];
  if (!options.includeDnp) base.push("--no-dnp");
  const tail = ["-o", options.output, options.board];
  const attempt = async (fused: boolean) => {
    const result = await runKicadCli(cli, [...base, ...(fused ? ["--fuse-shapes"] : []), ...tail], {
      tolerateExit: true,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const warnings = result.stderr
      .split("\n")
      .filter((line) => /file not found|problems encountered|warning/i.test(line))
      .map((line) => line.trim());
    return { ok: existsSync(options.output), warnings, exitCode: result.exitCode, stderr: result.stderr };
  };
  const fused = await attempt(true);
  if (fused.ok) return { fused: true, warnings: fused.warnings };
  const plain = await attempt(false);
  if (plain.ok) return { fused: false, warnings: plain.warnings };
  throw new Error(`pcb export glb failed (${plain.exitCode}): ${lastLines(plain.stderr)}`);
}

export interface BoardStats {
  width: number;
  height: number;
  thickness: number;
  footprints: number;
  frontFootprints: number;
  backFootprints: number;
}

const UNAVAILABLE_MINIMUM_MM = 2147.483;
const MINIMUM_FIELDS = ["min_track_clearance", "min_track_width", "min_drill_diameter"] as const;

/** Replaces KiCad's INT_MAX-derived "no measurement" values with an explicit missing value. */
export function normalizeBoardStatsReport(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const report = { ...(raw as Record<string, unknown>) };
  const board = report["board"];
  if (!board || typeof board !== "object" || Array.isArray(board)) return report;
  const normalizedBoard = { ...(board as Record<string, unknown>) };
  for (const field of MINIMUM_FIELDS) {
    const value = normalizedBoard[field];
    if (typeof value === "string" && Number.parseFloat(value) >= UNAVAILABLE_MINIMUM_MM) normalizedBoard[field] = null;
  }
  report["board"] = normalizedBoard;
  return report;
}

/** Probe the installed command set: version numbers do not guarantee this optional export. */
export async function supportsBoardStats(cli: KicadCli): Promise<boolean> {
  const help = await runKicadCli(cli, ["pcb", "export", "--help"]);
  return /^\s+stats\s+/m.test(help.stdout);
}

export function boardStatsUnavailableMessage(cli: KicadCli): string {
  return (
    `Board statistics unavailable: KiCad ${cli.version} at ${cli.path} does not provide ` +
    "'pcb export stats'. Use a KiCad build that includes this command for kicad_stats; " +
    "DRC, rendering and other exports can still be used."
  );
}

export class BoardStatsUnavailableError extends Error {
  constructor(cli: KicadCli) {
    super(boardStatsUnavailableMessage(cli));
    this.name = "BoardStatsUnavailableError";
  }
}

/** Reads outline and component counts through `kicad-cli pcb export stats`. */
export async function boardStats(cli: KicadCli, board: string, scratchFile: string): Promise<BoardStats> {
  if (!(await supportsBoardStats(cli))) throw new BoardStatsUnavailableError(cli);
  await runKicadCli(cli, ["pcb", "export", "stats", "--format", "json", "--units", "mm", "-o", scratchFile, board]);
  const raw = normalizeBoardStatsReport(await Bun.file(scratchFile).json()) as {
    board: { width: string; height: string; board_thickness: string };
    components: { total: { front: number; back: number; total: number } };
  };
  await Bun.write(scratchFile, JSON.stringify(raw, null, 2) + "\n");
  const mm = (value: string) => Number.parseFloat(value.replace(/[^\d.]/g, ""));
  return {
    width: round(mm(raw.board.width)),
    height: round(mm(raw.board.height)),
    thickness: round(mm(raw.board.board_thickness)),
    footprints: raw.components.total.total,
    frontFootprints: raw.components.total.front,
    backFootprints: raw.components.total.back,
  };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
