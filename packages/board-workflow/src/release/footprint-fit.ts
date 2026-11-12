/**
 * Fit a KiCad footprint to JLC's own footprint for the same part: which rotation (0/90/180/270) puts our pads onto
 * JLC's, by pad number, then by pad position where the numbering differs; polarity renumbering for 2-pin LEDs/diodes.
 */
import { pyRound } from "../accept";
import { pySum } from "./csv";
import type { EdaPad } from "./lookup";
import type { PartPad } from "./parts";

export type PadLike = { n: string; x: number; y: number };

export interface Alignment {
  rotation: number;
  rms_mm: number;
  matched: number;
  origin_offset_mm: [number, number];
  unmatched_kicad: string[];
  unmatched_jlc: string[];
  fit?: "geometry";
  pin1_to_pin1?: boolean;
  geometry_fits?: Array<{ rotation: number; rms_mm: number; pin1_to_pin1: boolean }>;
  number_fit?: { rotation: number; rms_mm: number } | null;
}

const POLAR: Record<string, string> = { A: "A", K: "K", ANODE: "A", CATHODE: "K", "+": "A", "-": "K" };
const round3 = (x: number) => pyRound(x, 3);
const cs = (r: number): [number, number] => [Math.round(Math.cos((r * Math.PI) / 180)), Math.round(Math.sin((r * Math.PI) / 180))];
const mean = (a: number[]) => pySum(a) / a.length;

/** For a polarized 2-pin part whose JLC pad numbers mean different pins than ours, renumber JLC's pads by pin function. */
export function polarRenumber<T extends { n: string }>(ep: T[], enames: Record<string, string>, knames: Record<string, string>): { pads: T[]; renumbered: boolean } {
  const ef: Record<string, string> = {};
  for (const [n, v] of Object.entries(enames)) if (POLAR[v]) ef[n] = POLAR[v]!;
  const kf: Record<string, string> = {};
  for (const [n, v] of Object.entries(knames)) if (POLAR[v]) kf[POLAR[v]!] = n;
  const efv = Object.values(ef);
  if (Object.keys(ef).length !== 2 || Object.keys(kf).length !== 2 || new Set(efv).size !== 2 || !efv.includes("A") || !efv.includes("K")) return { pads: ep, renumbered: false };
  const m: Record<string, string> = {};
  for (const [en, f] of Object.entries(ef)) m[en] = kf[f]!;
  if (Object.entries(m).every(([a, b]) => a === b)) return { pads: ep, renumbered: false };
  return { pads: ep.map((q) => ({ ...q, n: m[q.n] ?? q.n })), renumbered: true };
}

function groupBy<T extends { n: string }>(pads: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const q of pads) if (q.n) (m.get(q.n) ?? m.set(q.n, []).get(q.n)!).push(q);
  return m;
}

/** Best rotation of the KiCad footprint (about its origin) onto JLC's, by pad number. */
export function align(kpads: PartPad[] | PadLike[], epads: EdaPad[] | PadLike[]): Alignment | null {
  const kn = groupBy(kpads as PadLike[]);
  const en = groupBy(epads as PadLike[]);
  const common = [...kn.keys()].filter((n) => en.has(n)).sort();
  if (!common.length) return null;
  const K = common.map((n) => [mean(kn.get(n)!.map((q) => q.x)), mean(kn.get(n)!.map((q) => q.y))] as const);
  const E = common.map((n) => [mean(en.get(n)!.map((q) => q.x)), mean(en.get(n)!.map((q) => q.y))] as const);
  const kc = [mean(K.map((p) => p[0])), mean(K.map((p) => p[1]))] as const;
  const ec = [mean(E.map((p) => p[0])), mean(E.map((p) => p[1]))] as const;
  let best: [number, number] | null = null;
  for (const r of [0, 90, 180, 270]) {
    const [c, s] = cs(r);
    // KiCad rotation is counter-clockwise on screen with Y down: (x, y) -> (x c + y s, -x s + y c)
    let err = 0;
    K.forEach(([kx, ky], i) => {
      const dx = kx - kc[0];
      const dy = ky - kc[1];
      const rx = dx * c + dy * s;
      const ry = -dx * s + dy * c;
      err += (rx - (E[i]![0] - ec[0])) ** 2 + (ry - (E[i]![1] - ec[1])) ** 2;
    });
    const rms = Math.sqrt(err / K.length);
    if (best === null || rms < best[1] - 1e-9) best = [r, rms];
  }
  const [r, rms] = best!;
  const [c, s] = cs(r);
  const kox = -kc[0];
  const koy = -kc[1];
  const off: [number, number] = [kox * c + koy * s - -ec[0], -kox * s + koy * c - -ec[1]];
  const numeric = /^[A-Z]?\d+$/;
  const ukk = [...kn.keys()].filter((n) => !en.has(n) && numeric.test(n)).sort();
  const uee = [...en.keys()].filter((n) => !kn.has(n) && numeric.test(n)).sort();
  return {
    rotation: r,
    rms_mm: round3(rms),
    matched: common.length,
    origin_offset_mm: [round3(off[0]), round3(off[1])],
    unmatched_kicad: ukk.slice(0, 12),
    unmatched_jlc: uee.slice(0, 12),
  };
}

/** The same rotation search by pad position (nearest JLC pad) when the numbering differs (two-row connectors). */
export function alignGeometry(kpads: PartPad[] | PadLike[], epads: EdaPad[] | PadLike[]): Alignment | null {
  const kp = kpads as PadLike[];
  const ep = epads as PadLike[];
  if (!kp.length || kp.length !== ep.length) return null;
  const kc = [mean(kp.map((q) => q.x)), mean(kp.map((q) => q.y))] as const;
  const ec = [mean(ep.map((q) => q.x)), mean(ep.map((q) => q.y))] as const;
  const fits: Array<{ rotation: number; rms_mm: number; pin1_to_pin1: boolean; same_number: number; origin_offset_mm: [number, number] }> = [];
  for (const r of [0, 90, 180, 270]) {
    const [c, s] = cs(r);
    let err = 0;
    const mp = new Map<string, string>();
    for (const q of kp) {
      const dx = q.x - kc[0];
      const dy = q.y - kc[1];
      const rx = dx * c + dy * s;
      const ry = -dx * s + dy * c;
      let e = ep[0]!;
      let bd = Infinity;
      for (const p of ep) {
        const d = (p.x - ec[0] - rx) ** 2 + (p.y - ec[1] - ry) ** 2;
        if (d < bd) {
          bd = d;
          e = p;
        }
      }
      err += (e.x - ec[0] - rx) ** 2 + (e.y - ec[1] - ry) ** 2;
      if (!mp.has(q.n)) mp.set(q.n, e.n);
    }
    const kox = -kc[0];
    const koy = -kc[1];
    fits.push({
      rotation: r,
      rms_mm: round3(Math.sqrt(err / kp.length)),
      pin1_to_pin1: mp.get("1") === "1",
      same_number: [...mp].filter(([a, b]) => a === b).length,
      origin_offset_mm: [round3(kox * c + koy * s - -ec[0]), round3(-kox * s + koy * c - -ec[1])],
    });
  }
  const ok = fits.filter((f) => f.rms_mm < 0.1);
  if (!ok.length) return null;
  // max by (pin1, same_number, -rms); the first of equal candidates wins (Python max)
  let b = ok[0]!;
  for (const f of ok.slice(1)) {
    const cmp = Number(f.pin1_to_pin1) - Number(b.pin1_to_pin1) || f.same_number - b.same_number || b.rms_mm - f.rms_mm;
    if (cmp > 0) b = f;
  }
  return {
    rotation: b.rotation,
    rms_mm: b.rms_mm,
    matched: kp.length,
    origin_offset_mm: b.origin_offset_mm,
    unmatched_kicad: [],
    unmatched_jlc: [],
    fit: "geometry",
    pin1_to_pin1: b.pin1_to_pin1,
    geometry_fits: ok.map((f) => ({ rotation: f.rotation, rms_mm: f.rms_mm, pin1_to_pin1: f.pin1_to_pin1 })),
  };
}
