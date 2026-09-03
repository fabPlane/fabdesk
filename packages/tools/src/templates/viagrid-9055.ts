/**
 * Viagrid 9055 Standard (Opulo, https://github.com/opulo-inc/viagrid): a prefabricated 90 x 55 mm two-layer
 * blank with 180 factory vias and four mounting holes. A design may change layers only through those vias;
 * copper is removed afterwards (laser, etch or CNC) to isolate the nets. Coordinates are board-relative
 * millimetres with +y up, read from the blank's manufacturing file
 * (VIAGRID BLANK FILES/9055 STANDARD/KICAD/MANUFACTURING/viagrid.kicad_pcb, board origin 148.75, 88.75).
 */
export const VIAGRID_9055 = {
  id: "viagrid-9055" as const,
  widthMm: 90,
  heightMm: 55,
  layers: 2,
  viaPadMm: 1.0,
  viaDrillMm: 0.2,
  holeDrillMm: 3.5,
  /** KiCad netclass of the blank's project file. */
  rules: { traceWidthMm: 0.2, clearanceMm: 0.2 },
  /** File the template component is written to inside a project. */
  file: "viagrid-9055.tsx",
  component: "Viagrid9055Blank",
};

/** The 180 factory vias: rows at y = +/-20.5, columns at x = +/-38, two 39-via clusters centred on x = +/-19. */
export const VIAGRID_9055_VIAS: ReadonlyArray<readonly [number, number]> = [[-38.00,10.00],[17.00,-20.50],[19.00,-2.00],[-23.00,10.00],[-33.00,20.50],[-23.00,-10.00],[21.00,10.00],[-38.00,6.00],[-5.00,-20.50],[-13.00,-20.50],[27.00,-20.50],[38.00,4.00],[1.00,-20.50],[7.00,20.50],[9.00,20.50],[-3.00,20.50],[-3.00,-20.50],[-17.00,-8.00],[-29.00,-20.50],[-38.00,-4.00],[25.00,10.00],[-38.00,4.00],[21.00,12.00],[17.00,-12.00],[-23.00,8.00],[-38.00,-0.00],[21.00,-0.00],[-21.00,8.00],[-38.00,8.00],[38.00,2.00],[-13.00,20.50],[-33.00,-20.50],[15.00,8.00],[23.00,10.00],[-38.00,12.00],[15.00,-12.00],[19.00,20.50],[17.00,20.50],[38.00,8.00],[-21.00,20.50],[5.00,-20.50],[13.00,-10.00],[-21.00,10.00],[-38.00,-10.00],[19.00,-0.00],[29.00,20.50],[-17.00,12.00],[19.00,-12.00],[23.00,-20.50],[38.00,10.00],[19.00,2.00],[-38.00,-2.00],[-19.00,12.00],[13.00,-20.50],[-19.00,8.00],[19.00,12.00],[-17.00,-0.00],[33.00,-20.50],[11.00,-20.50],[15.00,20.50],[15.00,12.00],[5.00,20.50],[38.00,12.00],[7.00,-20.50],[-38.00,-12.00],[-23.00,-20.50],[23.00,-8.00],[21.00,20.50],[25.00,20.50],[23.00,-12.00],[-21.00,-8.00],[38.00,-14.00],[-21.00,12.00],[-25.00,10.00],[1.00,20.50],[-27.00,20.50],[38.00,-4.00],[-19.00,-10.00],[21.00,-20.50],[-31.00,20.50],[17.00,12.00],[-11.00,-20.50],[-19.00,-0.00],[-23.00,-12.00],[-35.00,20.50],[-25.00,20.50],[38.00,-2.00],[29.00,-20.50],[-25.00,-20.50],[38.00,-6.00],[-1.00,20.50],[-21.00,-12.00],[9.00,-20.50],[38.00,-10.00],[19.00,8.00],[-21.00,-20.50],[25.00,-20.50],[33.00,20.50],[-1.00,-20.50],[-9.00,-20.50],[-17.00,8.00],[15.00,-10.00],[23.00,12.00],[-35.00,-20.50],[31.00,-20.50],[-29.00,20.50],[38.00,-8.00],[-11.00,20.50],[15.00,-8.00],[17.00,-8.00],[21.00,-12.00],[-15.00,20.50],[-38.00,-6.00],[-9.00,20.50],[-19.00,-12.00],[35.00,20.50],[3.00,20.50],[-7.00,-20.50],[-23.00,12.00],[-19.00,2.00],[21.00,8.00],[-13.00,10.00],[-17.00,-10.00],[19.00,10.00],[25.00,-10.00],[38.00,14.00],[-15.00,8.00],[35.00,-20.50],[-19.00,-8.00],[-17.00,-12.00],[-25.00,-10.00],[11.00,20.50],[-38.00,-8.00],[31.00,20.50],[17.00,-10.00],[17.00,10.00],[27.00,20.50],[23.00,8.00],[23.00,20.50],[-23.00,20.50],[-19.00,10.00],[-23.00,-8.00],[-38.00,-14.00],[-31.00,-20.50],[-17.00,10.00],[38.00,-0.00],[19.00,-10.00],[3.00,-20.50],[17.00,8.00],[-21.00,-10.00],[-19.00,-2.00],[23.00,-10.00],[-17.00,20.50],[-38.00,14.00],[-21.00,-0.00],[15.00,10.00],[-15.00,-20.50],[-15.00,-10.00],[19.00,-20.50],[-13.00,-10.00],[15.00,-20.50],[38.00,-12.00],[-15.00,-12.00],[-17.00,-20.50],[19.00,-8.00],[21.00,-8.00],[-5.00,20.50],[13.00,10.00],[-15.00,12.00],[-19.00,-20.50],[-38.00,2.00],[13.00,20.50],[38.00,6.00],[-27.00,-20.50],[21.00,-10.00],[-15.00,10.00],[-15.00,-8.00],[-19.00,20.50],[-7.00,20.50],[17.00,-0.00]];

export const VIAGRID_9055_HOLES: ReadonlyArray<readonly [number, number]> = [[-38.75, 18.25], [38.75, 18.25], [-38.75, -18.25], [38.75, -18.25]];

/** True when (x, y) sits on a factory via (within `toleranceMm`). */
export function isOnViagrid9055Via(x: number, y: number, toleranceMm = 0.05): boolean {
  return VIAGRID_9055_VIAS.some(([vx, vy]) => Math.hypot(vx - x, vy - y) <= toleranceMm);
}

/** tscircuit source for the blank; the project imports `Viagrid9055Blank` from `viagrid-9055.tsx`. */
export function viagrid9055Tsx(): string {
  const vias = JSON.stringify(VIAGRID_9055_VIAS);
  const holes = JSON.stringify(VIAGRID_9055_HOLES);
  return `// Viagrid 9055 Standard blank (Opulo): 90 x 55 mm, 2 layers, 180 factory vias (1.0 mm pad / 0.2 mm drill)
// and 4 mounting holes (3.5 mm). Written by fabdesk (project_set_board template=viagrid-9055); regenerated on demand.
// Coordinates are board-relative mm, +y up. Route through these vias only: they are marked netIsAssignable so
// the laser-prefab router claims them; never place your own <via>.
export const VIAGRID_9055_VIAS: ReadonlyArray<readonly [number, number]> = ${vias};
export const VIAGRID_9055_HOLES: ReadonlyArray<readonly [number, number]> = ${holes};

export const Viagrid9055Blank = () => (
  <group name="viagrid">
    {VIAGRID_9055_VIAS.map(([x, y], i) => (
      <via key={"vg" + i} name={"VG" + i} pcbX={x} pcbY={y} fromLayer="top" toLayer="bottom" outerDiameter="1mm" holeDiameter="0.2mm" netIsAssignable />
    ))}
    {VIAGRID_9055_HOLES.map(([x, y], i) => (
      <hole key={"mh" + i} name={"MH" + i} pcbX={x} pcbY={y} diameter="3.5mm" />
    ))}
  </group>
);
`;
}

/** Starter circuit.tsx for a fresh Viagrid project. */
export function viagrid9055StarterTsx(): string {
  return `// Fabdesk project on a Viagrid 9055 blank. Keep <Viagrid9055Blank /> in the board; place parts between the
// via clusters (x in -12..12, or |x| > 26 and |y| < 14) and away from the mounting holes at (+/-38.75, +/-18.25).
import { Viagrid9055Blank } from "./viagrid-9055";

export default () => (
  <board width="90mm" height="55mm">
    <Viagrid9055Blank />
    <resistor name="R1" resistance="1k" footprint="0805" pcbX={-5} pcbY={0} />
    <led name="LED1" color="red" footprint="0805" pcbX={5} pcbY={0} />
    <trace from=".R1 > .pin2" to=".LED1 > .anode" />
  </board>
);
`;
}
