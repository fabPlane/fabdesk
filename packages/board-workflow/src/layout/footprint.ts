/**
 * How much memory and time a router run on a board needs, from the board itself. KiCadRoutingTools (and TraceMaker) hold
 * a grid over the board outline on every copper layer, so memory follows outline area x copper layers / grid step², not
 * the board file's size: vme-wren (160 x 233 mm, 12 copper, 71 MB) peaked at 17.1 GB in one KRT `finish` (still rising
 * at 20 min), while jetson (180 x 100 mm, 10 copper, 86 MB) took 4.0 GiB. The old rule (0.06 GiB per MB of board file)
 * said ~4 GiB for both, so three parallel last-mile candidates on vme-wren ran a 24 GiB machine out of memory.
 *
 * Calibrated on those two boards: 104 bytes per grid cell across all copper layers plus a 0.5 GiB base (vme-wren ->
 * 18.6 GiB, jetson -> 7.4 GiB, conservative there). The file-size rule stays a floor.
 */
import type { Board } from "../board";

export const ROUTER_GRID_MM = 0.05;
const BYTES_PER_CELL = 104;
const BASE_GIB = 0.5;
const GIB_PER_BOARD_MB = 0.06;

export interface RouterFootprint {
  /** Grid cells over the outline on every copper layer, millions. */
  cellsM: number;
  /** Peak memory one router run is expected to hold, GiB. */
  memGiB: number;
  /** Suggested per-action time budget for a last-mile router step, seconds. */
  budgetS: number;
}

/** Footprint of one router run on `board` (parsed); `fileBytes` is the board file's size (the old floor). */
export function routerFootprint(board: Pick<Board, "outline" | "copperLayers">, fileBytes: number, gridMm = ROUTER_GRID_MM): RouterFootprint {
  const o = board.outline;
  const layers = Math.max(1, board.copperLayers.length);
  const cells = o ? ((o.maxX - o.minX) / gridMm) * ((o.maxY - o.minY) / gridMm) * layers : 0;
  const fromGrid = BASE_GIB + (cells * BYTES_PER_CELL) / 2 ** 30;
  const fromFile = GIB_PER_BOARD_MB * (fileBytes / 1e6);
  const cellsM = cells / 1e6;
  return {
    cellsM: Math.round(cellsM * 10) / 10,
    memGiB: Math.round(Math.max(0.5, fromGrid, fromFile) * 10) / 10,
    // one KRT finish on vme-wren (179 M cells) ran past 20 min; 10 s per million cells over a 180 s floor, at most an hour
    budgetS: Math.round(Math.min(3600, 180 + 10 * cellsM)),
  };
}
