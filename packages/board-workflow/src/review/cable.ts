/**
 * Cable reach between boards in a case (the toolkit's `flow/cablepath.py`, `pcb cable`): does a catalog cable reach
 * from one board's connector to another's, in each stated chassis frame? Seconds, no KiCad run.
 *
 * CHASSIS (data; every number has a basis, assumptions are named so the owner can correct them):
 *   {"frames": {"no-rotation": {"basis": "...", "boards": {
 *        "C6":  {"pcb": "io-c6/release/C6/C6.kicad_pcb", "origin": [0, 0], "yaw": 0, "face_z": {"F": 1.0, "B": 0.0}},
 *        "R1N": {"pcb": "...carrier.kicad_pcb", "origin": [74.9, 13.4], "yaw": 0, "face_z": {"F": 1.6, "B": 0.0}}}}},
 *    "cables": [{"id": "ffc40", "a": ["C6", "C18_J401"], "b": ["R1N", "JPERIPH1"], "length_mm": 76.2, "tolerance_mm": 1.5,
 *                "kind": "ffc", "lead_mm": 3.0, "bend_mm": 1.5, "basis": "Samtec FJH-40-R-03.00-4 (3.00 in)"}]}
 * Chassis frame = the first board's frame (mm, X right, Y down). A board's point p maps to origin + R(yaw) p (after
 * x -> -x when `mirror`: installed face down). face_z = height of each copper face in the case (a cable between faces
 * climbs |dz|).
 *
 * Mouth (where the plug enters): the courtyard side opposite the contact-pad centroid (`mouthOf`, the same rule as the
 * review's mouth check). The plug leaves the mouth along its outward normal for `lead_mm` (plug body / FFC stiffener),
 * likewise at the other end, then runs orthogonally: required = lead_a + lead_b + |dx| + |dy| + |dz| + turns x
 * (pi/2 x bend_mm), turns counting the direction changes from the outward normal at A to the inward normal at B;
 * slack = length - tolerance - required. PASS when slack >= 0. A cable much longer than needed (slack > excess_mm,
 * default 40) is flagged: it needs a fold store. Not modelled: parts and midframe ribs in the path (the path is the
 * shortest orthogonal one), twist, connector latch clearance. A PASS is a geometric reach check in the stated frame,
 * not installed fit.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pyRound } from "../accept";
import { kid, kids, num, parseSexpr, type SNode } from "../sexpr";
import { mouthOf, type Box } from "./geometry";

type Pt = [number, number];

export interface ChassisBoard {
  pcb: string;
  origin: [number, number];
  yaw?: number;
  mirror?: boolean;
  face_z?: Record<string, number>;
}

export interface ChassisFrame {
  basis?: string;
  boards: Record<string, ChassisBoard>;
}

export interface Cable {
  id: string;
  a: [string, string];
  b: [string, string];
  length_mm: number;
  tolerance_mm?: number;
  lead_mm?: number;
  bend_mm?: number;
  excess_mm?: number;
  kind?: string;
  basis?: string;
}

export interface Chassis {
  basis?: string;
  frames: Record<string, ChassisFrame>;
  cables: Cable[];
}

export interface CableEnd {
  board: string;
  ref: string;
  side: string;
  mouth: Pt;
  normal: Pt;
  z: number;
}

export interface CableResult {
  cable: string;
  verdict: "PASS" | "FAIL";
  required_mm: number;
  length_mm: number;
  tolerance_mm: number;
  slack_mm: number;
  turns: number;
  dz_mm: number;
  run_dx_mm: number;
  run_dy_mm: number;
  flags: string[];
  ends: CableEnd[];
  basis: string | null;
}

/** One board file as the cable check reads it: footprints by reference (last one wins) and the Edge.Cuts box. */
export interface CableBoard {
  raw: Map<string, SNode>;
  outline: Box;
}

/** Reads board files once per run; relative paths resolve against `base` (the project, or the toolkit's REPO). */
export class CableBoards {
  private cache = new Map<string, CableBoard>();
  constructor(
    readonly base: string,
    private read: (path: string) => Promise<string> = (p) => readFile(p, "utf8"),
  ) {}

  path(p: string): string {
    return isAbsolute(p) ? p : resolve(this.base, p);
  }

  async get(p: string): Promise<CableBoard> {
    const hit = this.cache.get(p);
    if (hit) return hit;
    const b = cableBoard(await this.read(this.path(p)), p);
    this.cache.set(p, b);
    return b;
  }
}

/** The toolkit's `cablepath.board`: footprints by reference and the box of the gr_line / gr_rect / gr_arc ends on Edge.Cuts. */
export function cableBoard(text: string, name = "board"): CableBoard {
  const root = parseSexpr(text);
  const raw = new Map<string, SNode>();
  for (const fp of kids(root, "footprint")) {
    const ref = kids(fp, "property").find((p) => p[1] === "Reference")?.[2];
    if (typeof ref === "string") raw.set(ref, fp);
  }
  const pts: Pt[] = [];
  for (const kind of ["gr_line", "gr_rect", "gr_arc"])
    for (const g of kids(root, kind)) {
      if (kid(g, "layer")?.[1] !== "Edge.Cuts") continue;
      for (const k of ["start", "end"]) {
        const p = kid(g, k);
        pts.push([num(p?.[1]), num(p?.[2])]);
      }
    }
  if (!pts.length) throw new Error(`${name}: no Edge.Cuts outline (gr_line / gr_rect / gr_arc)`);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { raw, outline: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}

export interface CableMouth {
  point: Pt;
  normal: Pt;
  side: string;
  box: Box;
}

/** Mouth point, outward unit normal, side and courtyard box in the board's own frame; `pose` overrides (x, y, rot). */
export function cableMouth(b: CableBoard, ref: string, pose?: readonly [number, number, number]): CableMouth {
  const fp = b.raw.get(ref);
  if (!fp) throw new Error(`${ref}: no such footprint`);
  const m = mouthOf(fp, pose);
  if (!m) throw new Error(`${ref}: no signal pads to infer the mouth`);
  return { point: m.point, normal: m.normal, side: m.side, box: m.box };
}

/** A board point (or, with vec, a direction) in the chassis frame: mirror (face down: x -> -x), then yaw, then origin. */
export function toChassis(b: ChassisBoard, p: Pt, vec = false): Pt {
  const a = ((b.yaw ?? 0) * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const q0: Pt = b.mirror ? [-p[0], p[1]] : p;
  const q: Pt = [q0[0] * c - q0[1] * s, q0[0] * s + q0[1] * c];
  return vec ? q : [b.origin[0] + q[0], b.origin[1] + q[1]];
}

const same = (u: Pt, v: Pt) => u[0] === v[0] && u[1] === v[1];

/** Direction changes for an orthogonal path leaving along nOut, covering d, arriving along nIn (a reversal counts 2). */
export function turns(nOut: Pt, d: Pt, nIn: Pt): number {
  const dirs: Pt[] = [nOut];
  for (const ax of [0, 1] as const) {
    if (Math.abs(d[ax]) > 0.5) {
      const v: Pt = ax === 0 ? [Math.sign(d[0]), 0] : [0, Math.sign(d[1])];
      if (!same(v, dirs[dirs.length - 1]!)) dirs.push(v);
    }
  }
  if (!same(nIn, dirs[dirs.length - 1]!)) dirs.push(nIn);
  let t = 0;
  for (let i = 1; i < dirs.length; i++) {
    const u = dirs[i - 1]!, v = dirs[i]!;
    t += u[0] === -v[0] && u[1] === -v[1] ? 2 : 1;
  }
  return t;
}

/** Python's round(x) for the normals (|x| is 0 or 1 up to float noise); -0 becomes 0. */
const iround = (x: number) => pyRound(x, 0) + 0;
const r2 = (p: Pt): Pt => [pyRound(p[0], 2), pyRound(p[1], 2)];
/** Python `f"{x:.Nf"}` (ties to even on the exact value). */
export const fmtF = (x: number, nd: number) => pyRound(x, nd).toFixed(nd);

export type Poses = Map<string, readonly [number, number, number]>;
export const poseKey = (board: string, ref: string) => `${board}\u0000${ref}`;

/** One cable in one frame. `poses` places connectors elsewhere (key `poseKey(board, ref)`), as the sweep does. */
export async function checkCable(boards: CableBoards, frame: ChassisFrame, cab: Cable, poses?: Poses): Promise<CableResult> {
  const ends: Array<CableEnd & { outline: Box }> = [];
  for (const k of ["a", "b"] as const) {
    const [bname, ref] = cab[k];
    const b = frame.boards[bname];
    if (!b) throw new Error(`cable ${cab.id}: board ${bname} is not in the frame`);
    const brd = await boards.get(b.pcb);
    const m = cableMouth(brd, ref, poses?.get(poseKey(bname, ref)));
    const n = toChassis(b, m.normal, true);
    ends.push({ board: bname, ref, side: m.side, mouth: toChassis(b, m.point), normal: [iround(n[0]), iround(n[1])], z: b.face_z?.[m.side] ?? 0.0, outline: brd.outline });
  }
  const lead = cab.lead_mm ?? 3.0;
  const [A, B] = ends as [CableEnd & { outline: Box }, CableEnd & { outline: Box }];
  const pa: Pt = [A.mouth[0] + lead * A.normal[0], A.mouth[1] + lead * A.normal[1]];
  const pb: Pt = [B.mouth[0] + lead * B.normal[0], B.mouth[1] + lead * B.normal[1]];
  const d: Pt = [pb[0] - pa[0], pb[1] - pa[1]];
  const nIn: Pt = [-B.normal[0] + 0, -B.normal[1] + 0];
  const t = turns(A.normal, d, nIn);
  const dz = Math.abs(A.z - B.z);
  const req = 2 * lead + Math.abs(d[0]) + Math.abs(d[1]) + dz + ((t * Math.PI) / 2) * (cab.bend_mm ?? 1.5);
  const tol = cab.tolerance_mm ?? 0;
  const slack = cab.length_mm - tol - req;
  // does a mouth face into its own board (the cable then runs under/over that board first)?
  const inward: string[] = [];
  for (const e of ends) {
    const o = e.outline, n = e.normal, m = e.mouth;
    const bb = frame.boards[e.board]!;
    const mo = [toChassis(bb, [o[0], o[1]]), toChassis(bb, [o[2], o[3]])];
    const lo: Pt = [Math.min(mo[0]![0], mo[1]![0]), Math.min(mo[0]![1], mo[1]![1])], hi: Pt = [Math.max(mo[0]![0], mo[1]![0]), Math.max(mo[0]![1], mo[1]![1])];
    const dist = n[0] > 0.5 ? hi[0] - m[0] : n[0] < -0.5 ? m[0] - lo[0] : n[1] > 0.5 ? hi[1] - m[1] : m[1] - lo[1];
    if (dist > 2.0) inward.push(`${e.ref} mouth is ${fmtF(dist, 1)} mm inside its board edge (cable crosses its own board)`);
  }
  const flags = [...inward, ...(slack > (cab.excess_mm ?? 40) ? [`excess ${fmtF(slack, 0)} mm needs a fold store`] : [])];
  return {
    cable: cab.id,
    verdict: slack >= 0 ? "PASS" : "FAIL",
    required_mm: pyRound(req, 1),
    length_mm: cab.length_mm,
    tolerance_mm: tol,
    slack_mm: pyRound(slack, 1),
    turns: t,
    dz_mm: pyRound(dz, 2),
    run_dx_mm: pyRound(d[0], 1),
    run_dy_mm: pyRound(d[1], 1),
    flags,
    ends: ends.map((e) => ({ board: e.board, ref: e.ref, side: e.side, mouth: r2(e.mouth), normal: e.normal, z: e.z })),
    basis: cab.basis ?? null,
  };
}

/** Python `repr` of a JSON number as the toolkit prints it (floats keep `.0`; ints from the file print bare). */
const pyNum = (x: number) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
/** Python `f"{x:+W.Nf}"` (-0.0 keeps its sign). */
const signed = (x: number, w: number, nd: number) => {
  const neg = x < 0 || Object.is(x, -0) || Object.is(pyRound(x, nd), -0);
  return (neg ? `-${fmtF(Math.abs(x), nd)}` : `+${fmtF(x, nd)}`).padStart(w);
};

/** The toolkit's one-line report of a cable in a frame. */
export function cableLine(frame: string, r: CableResult): string {
  return (
    `${frame.padEnd(14)} ${r.cable.padEnd(8)} ${r.verdict}  need ${fmtF(r.required_mm, 1).padStart(6)} mm  have ${pyNum(r.length_mm)}-${pyNum(r.tolerance_mm)}  ` +
    `slack ${signed(r.slack_mm, 6, 1)}  turns ${r.turns}  run ${signed(r.run_dx_mm, 0, 1)},${signed(r.run_dy_mm, 0, 1)} dz ${pyNum(r.dz_mm)}` +
    (r.flags.length ? `  [${r.flags.join("; ")}]` : "")
  );
}

export interface CableRun {
  results: Record<string, CableResult[]>;
  failed: number;
  lines: string[];
}

/**
 * Every cable in every frame (or the named frame). `pcb` replaces a board's file in every frame (`--pcb BOARD=PATH`:
 * an edited board, an edit candidate).
 */
export async function runCables(boards: CableBoards, ch: Chassis, opts: { frame?: string; pcb?: Record<string, string> } = {}): Promise<CableRun> {
  validateChassis(ch);
  for (const [bn, p] of Object.entries(opts.pcb ?? {})) for (const fr of Object.values(ch.frames)) if (fr.boards[bn]) fr.boards[bn] = { ...fr.boards[bn]!, pcb: p };
  if (opts.frame && !ch.frames[opts.frame]) throw new Error(`no frame ${opts.frame} (frames: ${Object.keys(ch.frames).join(", ")})`);
  const results: Record<string, CableResult[]> = {};
  const lines: string[] = [];
  let failed = 0;
  for (const [fname, fr] of Object.entries(ch.frames)) {
    if (opts.frame && fname !== opts.frame) continue;
    const rows: CableResult[] = [];
    for (const c of ch.cables) rows.push(await checkCable(boards, fr, c));
    results[fname] = rows;
    for (const r of rows) {
      failed += r.verdict !== "PASS" ? 1 : 0;
      lines.push(cableLine(fname, r));
    }
  }
  return { results, failed, lines };
}

export type Edge = "right" | "left" | "front" | "back";
const WANT: Record<Edge, Pt> = { right: [1, 0], left: [-1, 0], front: [0, 1], back: [0, -1] };

export interface SweepRow {
  pos: number;
  pose: [number, number, number];
  /** `frame:cable` -> slack mm. */
  slack: Record<string, number>;
}

/**
 * Slide REF along one edge of its board (mouth facing out of that edge), score every cable that uses it in every frame
 * (or `frames`). The courtyard is not checked against parts here: prove the chosen pose with an edit (board_edit move).
 */
export async function sweepCable(boards: CableBoards, ch: Chassis, boardName: string, ref: string, edge: Edge, opts: { step?: number; margin?: number; frames?: string[] } = {}): Promise<SweepRow[]> {
  validateChassis(ch);
  const step = opts.step ?? 1.0, margin = opts.margin ?? 0.0;
  if (!(step > 0)) throw new Error("step must be > 0");
  const fr0 = Object.values(ch.frames)[0];
  const b0Board = fr0?.boards[boardName];
  if (!b0Board) throw new Error(`board ${boardName} is not in the first frame`);
  const brd = await boards.get(b0Board.pcb);
  const out = brd.outline;
  const want = WANT[edge];
  if (!want) throw new Error(`edge must be right | left | front | back`);
  let rot: number | null = null;
  let b0: Box = [0, 0, 0, 0];
  for (const r of [0, 90, 180, 270]) {
    const m = cableMouth(brd, ref, [0, 0, r]);
    if (iround(m.normal[0]) === want[0] && iround(m.normal[1]) === want[1]) {
      rot = r;
      b0 = m.box;
      break;
    }
  }
  if (rot === null) throw new Error(`${ref}: no rotation puts the mouth on the ${edge} edge`);
  const cabs = ch.cables.filter((c) => (c.a[0] === boardName && c.a[1] === ref) || (c.b[0] === boardName && c.b[1] === ref));
  const rows: SweepRow[] = [];
  const side = edge === "right" || edge === "left";
  const [lo, hi] = side ? [out[1], out[3]] : [out[0], out[2]];
  const w = side ? b0[3] - b0[1] : b0[2] - b0[0];
  let v = lo + w / 2;
  while (v <= hi - w / 2 + 1e-9) {
    const pose: [number, number, number] =
      edge === "right" ? [out[2] - margin - b0[2], v, rot] : edge === "left" ? [out[0] + margin - b0[0], v, rot] : edge === "front" ? [v, out[3] - margin - b0[3], rot] : [v, out[1] + margin - b0[1], rot];
    const row: SweepRow = { pos: pyRound(v, 2), pose: [pyRound(pose[0], 3), pyRound(pose[1], 3), rot], slack: {} };
    for (const [fname, fr] of Object.entries(ch.frames)) {
      if (opts.frames && !opts.frames.includes(fname)) continue;
      for (const c of cabs) row.slack[`${fname}:${c.id}`] = (await checkCable(boards, fr, c, new Map([[poseKey(boardName, ref), pose]]))).slack_mm;
    }
    rows.push(row);
    v += step;
  }
  return rows;
}

/** The toolkit's sweep table. */
export function sweepLines(rows: readonly SweepRow[]): string[] {
  if (!rows.length) return [];
  const keys = Object.keys(rows[0]!.slack);
  const pyList = (p: readonly number[]) => `[${p.map((x, i) => (i < 2 ? pyNum(x) : String(x))).join(", ")}]`;
  return [
    "pos    pose                      " + keys.map((k) => k.padStart(18)).join("  "),
    ...rows.map((r) => `${fmtF(r.pos, 1).padStart(6)} ${pyList(r.pose).padEnd(26)}` + keys.map((k) => pyNum(r.slack[k]!).padStart(18)).join("  ")),
  ];
}

/** Shape check with messages that name the field (the chassis file is hand-written). */
export function validateChassis(ch: unknown): asserts ch is Chassis {
  const c = ch as Partial<Chassis> | null;
  if (!c || typeof c !== "object" || !c.frames || typeof c.frames !== "object" || !Object.keys(c.frames).length) throw new Error("chassis: needs frames {name: {boards: {...}}}");
  if (!Array.isArray(c.cables)) throw new Error("chassis: needs cables [...]");
  for (const [fn, fr] of Object.entries(c.frames)) {
    if (!fr || typeof fr.boards !== "object") throw new Error(`chassis: frame ${fn} needs boards`);
    for (const [bn, b] of Object.entries(fr.boards))
      if (!b || typeof b.pcb !== "string" || !Array.isArray(b.origin) || b.origin.length !== 2) throw new Error(`chassis: frame ${fn} board ${bn} needs pcb and origin [x, y]`);
  }
  for (const cab of c.cables)
    if (!cab || typeof cab.id !== "string" || !Array.isArray(cab.a) || !Array.isArray(cab.b) || typeof cab.length_mm !== "number") throw new Error(`chassis: every cable needs id, a [board, ref], b [board, ref], length_mm`);
}

/** Every board file a chassis names (for the caller to confine or check before reading). */
export function chassisBoardFiles(ch: Chassis): string[] {
  return [...new Set(Object.values(ch.frames).flatMap((f) => Object.values(f.boards).map((b) => b.pcb)))];
}
