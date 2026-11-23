/**
 * Simulate JLC's placement of every CPL row and compare it with our copper.
 *
 * For each placed part, JLC's own footprint (EasyEDA, from the BOM cache) is put down the way JLC reads the CPL, and its
 * pads are compared with our pads as plotted in the copper Gerbers (X2 %TO.P,ref,pad% attributes = absolute ground truth).
 *
 * JLC CPL convention used (kicad-jlcpcb-tools, fabrication.py: bottom rotation = 180 - KiCad angle, Mid X not
 * mirrored, Mid Y = -board y, position = centre of the soldered pads' bounding box; every JLC footprint in our caches has
 * its origin at its pad-bbox centre):
 *   top:    pad = C + Rot(R) e            e = JLC footprint pad relative to its origin, Y up, Rot counter-clockwise
 *   bottom: pad = C + Mx Rot(R) e         Mx: x -> -x (the part is seen from below)
 * With KiCad's bottom flip (pads mirrored in y, file angle t) this is R = 180 - t for a footprint drawn like JLC's.
 *
 * A part passes when JLC's lands sit on ours (RMS < 0.5 mm; > 0.25 noted as a land-pattern difference) and every one of
 * our pads meets the same pin: same number, a number inside a merged JLC pad name ("A1-B12"), or the same pin name.
 * Where JLC numbers the same lands differently (no rotation matches numbers, e.g. two-row connectors zig-zag vs row-wise),
 * pin 1 must meet pin 1. `solve` writes the rotation and centre that put JLC's footprint on our lands.
 */
import { pyRound } from "../accept";
import { pySum } from "./csv";
import { polarRenumber } from "./footprint-fit";
import { edaPadsOf, edaPinNames, type FetchRecord } from "./lookup";

export const LAND_TOL = 0.5;
export const LAND_NOTE = 0.25;
const MECH = new Set(["EH", "SH", "SHIELD", "MH", "MP", "NC", "PAD", "SHELL"]);

export const CONVENTION =
  "JLC CPL convention used (kicad-jlcpcb-tools, fabrication.py: bottom rotation = 180 - KiCad angle, Mid X not mirrored, Mid Y = -board y, position = centre of the soldered pads' bounding box; every JLC footprint in our caches has its origin at its pad-bbox centre)";

type Pt = [number, number];
export type OurPads = Record<string, Pt[]>;
type JlcPad = { n: string; x: number; y: number };

export const padCentre = (padsOfRef: OurPads): Pt => {
  const pts = Object.values(padsOfRef).flat();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
};

const place = (e: JlcPad, C: Pt, R: number, bottom: boolean): Pt => {
  const c = Math.cos(R * (Math.PI / 180));
  const s = Math.sin(R * (Math.PI / 180));
  let x = e.x * c - e.y * s;
  const y = e.x * s + e.y * c;
  if (bottom) x = -x;
  return [C[0] + x, C[1] + y];
};

export const nname = (s: string | undefined): string => {
  let t = (s ?? "").toUpperCase().replace(/~\{/g, "").replace(/\{/g, "").replace(/\}/g, "").replace(/#/g, "").replace(/\//g, "");
  t = t.replace(/D\+/g, "DP").replace(/D-/g, "DN");
  return MECH.has(t) ? "MECH" : t;
};

const isDigits = (s: string) => /^\d+$/.test(s);

function samePin(n: string, m: string, kn: Record<string, string>, en: Record<string, string>, polar: Record<string, string> | null, off = 0): boolean {
  if (polar !== null) return polar[n] === m;
  if (off && isDigits(n) && String(parseInt(n, 10) - off) === m) return true;
  if (m === n || m.split("-").includes(n)) return true;
  const oursMech = nname(n) === "MECH" || nname(kn[n]) === "MECH" || /^(S|MP|SH|EH)\d*$/.test(n.toUpperCase());
  if (oursMech && (m === "0" || m === "" || nname(en[m]) === "MECH" || /^(S|MP|SH|EH)\d*$/.test(m.toUpperCase()))) return true; // shield / mounting tabs
  const a = nname(kn[n]);
  const b = nname(en[m]);
  if (a && b) {
    if (a === b) return true;
    const sa = a.replace(/\d+$/, "");
    if (sa === b.replace(/\d+$/, "") && (sa === "DP" || sa === "DN")) return true; // USB DP/DN on either row of a type-C receptacle
  }
  return false;
}

/** A constant number offset (a second socket numbered 101..200): 0 when the numbers meet as they are. */
export function numberOffset(ours: OurPads, jlc: JlcPad[]): number {
  const on = Object.keys(ours).filter(isDigits);
  const en = new Set(jlc.filter((q) => isDigits(q.n)).map((q) => q.n));
  if (!on.length || !en.size || on.some((n) => en.has(n))) return 0;
  const off = Math.min(...on.map(Number)) - Math.min(...[...en].map(Number));
  return on.every((n) => en.has(String(parseInt(n, 10) - off))) ? off : 0;
}

function score(ours: OurPads, jlc: JlcPad[], C: Pt, R: number, bottom: boolean, kn: Record<string, string>, en: Record<string, string>, polar: Record<string, string> | null, off = 0): [number, number, boolean | null] {
  const placed = jlc.map((q) => [q.n, place(q, C, R, bottom)] as const);
  const land: number[] = [];
  const same: boolean[] = [];
  let pin1: boolean | null = null;
  for (const [n, pts] of Object.entries(ours))
    for (const p of pts) {
      let best = placed[0]!;
      let bd = Infinity;
      for (const t of placed) {
        const d = Math.hypot(p[0] - t[1][0], p[1] - t[1][1]);
        if (d < bd) {
          bd = d;
          best = t;
        }
      }
      land.push(bd);
      same.push(samePin(n, best[0], kn, en, polar, off));
      if (n === String(1 + off)) pin1 = !!pin1 || (polar ? polar["1"] === best[0] : best[0] === "1");
    }
  const rms = land.length ? Math.sqrt(pySum(land.map((x) => x * x)) / land.length) : 99.0;
  return [rms, same.length ? same.filter(Boolean).length / same.length : 0.0, pin1];
}

/** Polarized 2-pin part whose JLC numbers mean the other pins: our number -> JLC number, else null. */
export function polarityMap(jlc: JlcPad[], en: Record<string, string>, kn: Record<string, string>): Record<string, string> | null {
  const r = polarRenumber(jlc.map((q) => ({ ...q })), en, kn);
  if (!r.renumbered) return null;
  const out: Record<string, string> = {};
  jlc.forEach((q0, i) => (out[r.pads[i]!.n] = q0.n));
  return out;
}

type Fit = [number, Pt, number, number, boolean | null];

function fits(ours: OurPads, jlc: JlcPad[], bottom: boolean, kn: Record<string, string>, en: Record<string, string>, polar: Record<string, string> | null, off = 0): Fit[] {
  const allp = Object.values(ours).flat();
  const res: Fit[] = [];
  for (const R of [0, 90, 180, 270]) {
    const ex = jlc.map((q) => place(q, [0, 0], R, bottom));
    const C: Pt = [pySum(allp.map((p) => p[0])) / allp.length - pySum(ex.map((p) => p[0])) / ex.length, pySum(allp.map((p) => p[1])) / allp.length - pySum(ex.map((p) => p[1])) / ex.length];
    res.push([R, C, ...score(ours, jlc, C, R, bottom, kn, en, polar, off)] as Fit);
  }
  return res;
}

export interface CplRowIn {
  Designator: string;
  "Mid X": string;
  "Mid Y": string;
  Layer: string;
  Rotation: string;
  [k: string]: string;
}

export interface SimPart {
  ref: string;
  side: "F" | "B";
  lcsc: string | undefined;
  cpl_rot: number;
  cpl_xy: Pt;
  verdict: "PASS" | "FAIL" | "NO DATA";
  why?: string;
  proxy?: { proxy: string; why?: string | undefined };
  jlc_footprint?: string | null;
  map?: string;
  numbering_differs?: boolean;
  land_rms?: number;
  same_pin?: number;
  pin1_on_pin1?: boolean | null;
  note?: string;
  solved?: { rot: number; xy: Pt; land_rms: number; same_pin: number; pin1_on_pin1: boolean | null; moved_mm: number; verdict: "PASS" | "FAIL" };
}

export interface SimInput {
  cpl: CplRowIn[];
  /** Designator -> LCSC code (from the JLC BOM). */
  codes: Record<string, string | undefined>;
  top: Map<string, Pt[]>;
  bottom: Map<string, Pt[]>;
  /** The EasyEDA components record for an LCSC code, from the BOM cache; null when none. */
  eda: (code: string) => FetchRecord | null;
  /** Our schematic symbol pin names for a reference. */
  pinNames?: (ref: string) => Record<string, string>;
  /** {LCSC: {proxy, why}}: JLC has no footprint for LCSC; check with the proxy's (same package). */
  proxies?: Record<string, { proxy: string; why?: string | undefined }>;
}

export interface SimResult {
  summary: { placements: number; pass: number; fail: number; no_jlc_footprint: string[]; checked_with_proxy_footprint: string[]; land_notes: string[] };
  convention: string;
  parts: SimPart[];
  solved_rows: CplRowIn[];
}

function oursFor(map: Map<string, Pt[]>, ref: string): OurPads {
  const out: OurPads = {};
  for (const [k, pts] of map) {
    const [rf, pad] = k.split("\u0000");
    if (rf === ref && pad) out[pad] = pts;
  }
  return out;
}

export function simulatePlacement(inp: SimInput): SimResult {
  const proxies = inp.proxies ?? {};
  const parts: SimPart[] = [];
  const solvedRows: CplRowIn[] = [];
  // index the copper pads by ref once
  const idx = (m: Map<string, Pt[]>) => {
    const by = new Map<string, OurPads>();
    for (const [k, pts] of m) {
      const [rf, pad] = k.split("\u0000");
      if (!rf || !pad) continue;
      (by.get(rf) ?? by.set(rf, {}).get(rf)!)[pad] = pts;
    }
    return by;
  };
  const topBy = idx(inp.top);
  const botBy = idx(inp.bottom);
  void oursFor;
  for (const r of inp.cpl) {
    const ref = r.Designator;
    const bottom = r.Layer.toLowerCase().startsWith("b");
    const C: Pt = [Number(r["Mid X"]), Number(r["Mid Y"])];
    const R = ((Number(r.Rotation) % 360) + 360) % 360;
    const ours = (bottom ? botBy : topBy).get(ref) ?? {};
    const code = inp.codes[ref];
    const rec: SimPart = { ref, side: bottom ? "B" : "F", lcsc: code, cpl_rot: R, cpl_xy: C, verdict: "NO DATA" };
    let raw = code ? inp.eda(code) : null;
    let jlc = raw ? edaPadsOf(raw, true) : null;
    let px: { proxy: string; why?: string | undefined } | undefined;
    if (!(jlc?.pads?.length) && code && proxies[code]) {
      px = proxies[code];
      raw = inp.eda(px.proxy);
      jlc = raw ? edaPadsOf(raw, true) : null;
    }
    const nr: CplRowIn = { ...r };
    const jp = jlc?.pads?.length ? jlc.pads.map((q) => ({ n: q.n, x: q.x, y: q.y })) : null;
    if (!Object.keys(ours).length || !jp) {
      rec.verdict = "NO DATA";
      rec.why = Object.keys(ours).length ? "JLC has no footprint for this part (JLC engineers draw one: check in the preview)" : "no pads in copper";
      parts.push(rec);
      solvedRows.push(nr);
      continue;
    }
    const en = raw ? edaPinNames(raw) : {};
    const kn = inp.pinNames?.(ref) ?? {};
    const polar = polarityMap(jp, en, kn);
    const off = numberOffset(ours, jp);
    const [land, frac, pin1] = score(ours, jp, C, R, bottom, kn, en, polar, off);
    const fl = fits(ours, jp, bottom, kn, en, polar, off);
    const nd = !fl.some((x) => x[2] < LAND_TOL && x[3] === 1.0) && fl.some((x) => x[2] < LAND_TOL);
    const good = (l: number, fr: number, p1: boolean | null) => l < LAND_TOL && (fr === 1.0 || (nd && p1 === true));
    const ok = good(land, frac, pin1);
    if (px) rec.proxy = px;
    Object.assign(rec, {
      jlc_footprint: jlc?.title ?? null,
      map: polar ? "polarity" : off ? `number-${off}` : "number/name",
      numbering_differs: nd,
      land_rms: pyRound(land, 3),
      same_pin: pyRound(frac, 3),
      pin1_on_pin1: pin1,
      verdict: ok ? "PASS" : "FAIL",
    });
    if (ok && land > LAND_NOTE) rec.note = `lands differ from JLC footprint (RMS ${land.toFixed(2)} mm): pins correct`;
    let best = fl[0]!;
    const key = (x: Fit) => [Number(!good(x[2], x[3], x[4])), x[2]] as const;
    for (const x of fl.slice(1)) if (key(x)[0] < key(best)[0] || (key(x)[0] === key(best)[0] && key(x)[1] < key(best)[1])) best = x;
    const [bR, bC, bl, bf, bp] = best;
    rec.solved = { rot: bR, xy: [pyRound(bC[0], 4), pyRound(bC[1], 4)], land_rms: pyRound(bl, 3), same_pin: pyRound(bf, 3), pin1_on_pin1: bp, moved_mm: pyRound(Math.hypot(bC[0] - C[0], bC[1] - C[1]), 3), verdict: good(bl, bf, bp) ? "PASS" : "FAIL" };
    if (!ok && good(bl, bf, bp)) {
      nr.Rotation = String(bR);
      nr["Mid X"] = bC[0].toFixed(6);
      nr["Mid Y"] = bC[1].toFixed(6);
    }
    parts.push(rec);
    solvedRows.push(nr);
  }
  return {
    summary: {
      placements: parts.length,
      pass: parts.filter((p) => p.verdict === "PASS").length,
      fail: parts.filter((p) => p.verdict === "FAIL").length,
      no_jlc_footprint: parts.filter((p) => p.verdict === "NO DATA").map((p) => p.ref),
      checked_with_proxy_footprint: parts.filter((p) => p.proxy).map((p) => p.ref),
      land_notes: parts.filter((p) => p.note).map((p) => p.ref),
    },
    convention: CONVENTION,
    parts,
    solved_rows: solvedRows,
  };
}
