/**
 * Viagrid 9055 Standard (Opulo, https://github.com/opulo-inc/viagrid): a prefabricated 90 x 55 mm two-layer
 * blank with 180 factory vias and four mounting holes. A design may change layers only through those vias;
 * copper is removed afterwards (laser, etch or CNC) to isolate the nets. Coordinates below are in the blank's
 * frame: board-relative millimetres, centre origin, +y up, read from the blank's manufacturing file
 * (VIAGRID BLANK FILES/9055 STANDARD/KICAD/MANUFACTURING/viagrid.kicad_pcb, board origin 148.75, 88.75).
 *
 * `viagrid9055BoardSpec()` is what circuit_build sends the design server for a project with
 * `board.template = "viagrid-9055"`: the outline, the 180 vias as free vias (no net) the laser-prefab router
 * claims, the holes as Edge.Cuts cutouts, and the blank's rules — in the board frame the compile draws
 * (outline top-left at the origin, +y down), see `viagridToBoard`.
 */
import type { FpPcbBoardSpec } from "@fabdesk/protocol";

export const VIAGRID_9055 = {
  id: "viagrid-9055" as const,
  widthMm: 90,
  heightMm: 55,
  layers: 2,
  viaPadMm: 1.0,
  viaDrillMm: 0.2,
  holeDrillMm: 3.5,
  /** KiCad netclass of the blank's project file, plus the factory via size. */
  rules: { traceWidthMm: 0.2, clearanceMm: 0.2, viaDiameterMm: 1.0, viaDrillMm: 0.2 },
};

/** The 180 factory vias: rows at y = +/-20.5, columns at x = +/-38, two 39-via clusters centred on x = +/-19. */
export const VIAGRID_9055_VIAS: ReadonlyArray<readonly [number, number]> = [[-38.00,10.00],[17.00,-20.50],[19.00,-2.00],[-23.00,10.00],[-33.00,20.50],[-23.00,-10.00],[21.00,10.00],[-38.00,6.00],[-5.00,-20.50],[-13.00,-20.50],[27.00,-20.50],[38.00,4.00],[1.00,-20.50],[7.00,20.50],[9.00,20.50],[-3.00,20.50],[-3.00,-20.50],[-17.00,-8.00],[-29.00,-20.50],[-38.00,-4.00],[25.00,10.00],[-38.00,4.00],[21.00,12.00],[17.00,-12.00],[-23.00,8.00],[-38.00,0.00],[21.00,0.00],[-21.00,8.00],[-38.00,8.00],[38.00,2.00],[-13.00,20.50],[-33.00,-20.50],[15.00,8.00],[23.00,10.00],[-38.00,12.00],[15.00,-12.00],[19.00,20.50],[17.00,20.50],[38.00,8.00],[-21.00,20.50],[5.00,-20.50],[13.00,-10.00],[-21.00,10.00],[-38.00,-10.00],[19.00,0.00],[29.00,20.50],[-17.00,12.00],[19.00,-12.00],[23.00,-20.50],[38.00,10.00],[19.00,2.00],[-38.00,-2.00],[-19.00,12.00],[13.00,-20.50],[-19.00,8.00],[19.00,12.00],[-17.00,0.00],[33.00,-20.50],[11.00,-20.50],[15.00,20.50],[15.00,12.00],[5.00,20.50],[38.00,12.00],[7.00,-20.50],[-38.00,-12.00],[-23.00,-20.50],[23.00,-8.00],[21.00,20.50],[25.00,20.50],[23.00,-12.00],[-21.00,-8.00],[38.00,-14.00],[-21.00,12.00],[-25.00,10.00],[1.00,20.50],[-27.00,20.50],[38.00,-4.00],[-19.00,-10.00],[21.00,-20.50],[-31.00,20.50],[17.00,12.00],[-11.00,-20.50],[-19.00,0.00],[-23.00,-12.00],[-35.00,20.50],[-25.00,20.50],[38.00,-2.00],[29.00,-20.50],[-25.00,-20.50],[38.00,-6.00],[-1.00,20.50],[-21.00,-12.00],[9.00,-20.50],[38.00,-10.00],[19.00,8.00],[-21.00,-20.50],[25.00,-20.50],[33.00,20.50],[-1.00,-20.50],[-9.00,-20.50],[-17.00,8.00],[15.00,-10.00],[23.00,12.00],[-35.00,-20.50],[31.00,-20.50],[-29.00,20.50],[38.00,-8.00],[-11.00,20.50],[15.00,-8.00],[17.00,-8.00],[21.00,-12.00],[-15.00,20.50],[-38.00,-6.00],[-9.00,20.50],[-19.00,-12.00],[35.00,20.50],[3.00,20.50],[-7.00,-20.50],[-23.00,12.00],[-19.00,2.00],[21.00,8.00],[-13.00,10.00],[-17.00,-10.00],[19.00,10.00],[25.00,-10.00],[38.00,14.00],[-15.00,8.00],[35.00,-20.50],[-19.00,-8.00],[-17.00,-12.00],[-25.00,-10.00],[11.00,20.50],[-38.00,-8.00],[31.00,20.50],[17.00,-10.00],[17.00,10.00],[27.00,20.50],[23.00,8.00],[23.00,20.50],[-23.00,20.50],[-19.00,10.00],[-23.00,-8.00],[-38.00,-14.00],[-31.00,-20.50],[-17.00,10.00],[38.00,0.00],[19.00,-10.00],[3.00,-20.50],[17.00,8.00],[-21.00,-10.00],[-19.00,-2.00],[23.00,-10.00],[-17.00,20.50],[-38.00,14.00],[-21.00,0.00],[15.00,10.00],[-15.00,-20.50],[-15.00,-10.00],[19.00,-20.50],[-13.00,-10.00],[15.00,-20.50],[38.00,-12.00],[-15.00,-12.00],[-17.00,-20.50],[19.00,-8.00],[21.00,-8.00],[-5.00,20.50],[13.00,10.00],[-15.00,12.00],[-19.00,-20.50],[-38.00,2.00],[13.00,20.50],[38.00,6.00],[-27.00,-20.50],[21.00,-10.00],[-15.00,10.00],[-15.00,-8.00],[-19.00,20.50],[-7.00,20.50],[17.00,0.00]];

export const VIAGRID_9055_HOLES: ReadonlyArray<readonly [number, number]> = [[-38.75, 18.25], [38.75, 18.25], [-38.75, -18.25], [38.75, -18.25]];

/** True when (x, y) in the blank's frame sits on a factory via (within `toleranceMm`). */
export function isOnViagrid9055Via(x: number, y: number, toleranceMm = 0.05): boolean {
  return VIAGRID_9055_VIAS.some(([vx, vy]) => Math.hypot(vx - x, vy - y) <= toleranceMm);
}

const round3 = (v: number) => {
  const r = Math.round(v * 1000) / 1000;
  return r === 0 ? 0 : r; // no -0
};

/** Blank frame (centre origin, +y up) -> the board frame circuit_build draws (top-left origin, +y down). */
export function viagridToBoard(x: number, y: number): [number, number] {
  return [round3(VIAGRID_9055.widthMm / 2 + x), round3(VIAGRID_9055.heightMm / 2 - y)];
}

/** Board frame -> blank frame; the inverse of `viagridToBoard`. */
export function boardToViagrid(x: number, y: number): [number, number] {
  return [round3(x - VIAGRID_9055.widthMm / 2), round3(VIAGRID_9055.heightMm / 2 - y)];
}

/** The blank as a compile board spec (board frame). Replaces the netlist file's `board` while the template is set. */
export function viagrid9055BoardSpec(): FpPcbBoardSpec {
  const r = VIAGRID_9055.rules;
  return {
    widthMm: VIAGRID_9055.widthMm,
    heightMm: VIAGRID_9055.heightMm,
    copperLayers: VIAGRID_9055.layers,
    rules: { clearanceMm: r.clearanceMm, trackWidthMm: r.traceWidthMm, viaDiameterMm: r.viaDiameterMm, viaDrillMm: r.viaDrillMm },
    vias: VIAGRID_9055_VIAS.map(([x, y]) => {
      const [bx, by] = viagridToBoard(x, y);
      return { x: bx, y: by, diameterMm: VIAGRID_9055.viaPadMm, drillMm: VIAGRID_9055.viaDrillMm };
    }),
    holes: VIAGRID_9055_HOLES.map(([x, y]) => {
      const [bx, by] = viagridToBoard(x, y);
      return { x: bx, y: by, diameterMm: VIAGRID_9055.holeDrillMm };
    }),
  };
}
