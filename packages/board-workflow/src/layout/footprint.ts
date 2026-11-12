/**
 * How much memory and time a router run on a board needs, from the board itself. KiCadRoutingTools (and TraceMaker) hold
 * a grid over the board outline on every copper layer, so memory follows outline area x copper layers / grid step², not
 * the board file's size: vme-wren (160 x 233 mm, 12 copper, 71 MB) peaked at 17.1 GB in one KRT `finish` (still rising
 * at 20 min), while jetson (180 x 100 mm, 10 copper, 86 MB) took 4.0 GiB. The old rule (0.06 GiB per MB of board file)
 * said ~4 GiB for both, so three parallel last-mile candidates on vme-wren ran a 24 GiB machine out of memory.
 *
 * Calibrated on those two boards: 104 bytes per grid cell across all copper layers plus a 0.5 GiB base. vme-wren -> 17.9
 * GiB against a measured peak of 16.25 GiB (17.0 GB) over a full 33-min step budget (the same peak as at 20 min: it levels
 * off); jetson -> 7.5 GiB against 4.0 GiB measured. The file-size rule stays a floor.
 *
 * `boardGridShape` reads only what the estimate needs (the layer table and the top-level Edge.Cuts drawings) in one pass
 * over the text: a full parse of a 90 MB board costs about 0.7 GiB, and the estimate is taken when memory is tight.
 */
import type { Board } from "../board";
import { kid, kids, num, parseSexpr, type SNode } from "../sexpr";

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

const OUTLINE_HEADS = new Set(["gr_line", "gr_rect", "gr_arc", "gr_circle", "gr_poly", "gr_curve"]);

/**
 * The outline box and copper layers of a board text, as `parseBoard` reads them (top-level `gr_*` drawings on Edge.Cuts;
 * `(layers …)` entries named F.Cu, B.Cu, InN.Cu), without parsing the rest of the board.
 */
export function boardGridShape(text: string): Pick<Board, "outline" | "copperLayers"> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  const pair = (n: SNode | undefined): [number, number] => [num(n?.[1]), num(n?.[2])];
  const copper = new Set<string>();
  let depth = 0, inStr = false, start = -1, head = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++; // backslash
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 40) {
      depth++;
      if (depth === 2) {
        let j = i + 1;
        while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) j++;
        head = text.slice(i + 1, j);
        start = head === "layers" || OUTLINE_HEADS.has(head) ? i : -1;
      }
    } else if (c === 41) {
      if (depth === 2 && start >= 0) {
        const span = text.slice(start, i + 1);
        if (head === "layers") {
          for (const m of span.matchAll(/"((?:F|B|In\d+)\.Cu)"/g)) copper.add(m[1]!);
        } else if (span.includes('"Edge.Cuts"')) {
          const g = parseSexpr(span);
          if (kid(g, "layer")?.[1] === "Edge.Cuts") {
            if (head === "gr_circle") {
              const [cx, cy] = pair(kid(g, "center"));
              const [ex, ey] = pair(kid(g, "end"));
              const r = Math.hypot(ex - cx, ey - cy);
              add(cx - r, cy - r);
              add(cx + r, cy + r);
            } else {
              for (const key of ["start", "mid", "end"]) {
                const n = kid(g, key);
                if (n) add(...pair(n));
              }
              for (const pts of kids(g, "pts")) for (const q of kids(pts, "xy")) add(num(q[1]), num(q[2]));
            }
          }
        }
        start = -1;
      }
      depth--;
    }
  }
  return { outline: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null, copperLayers: [...copper] };
}
