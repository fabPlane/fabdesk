/**
 * Close open power connections with net-assigned copper pours (port of the toolkit's `tools/pour_opens.py`).
 *
 * For every native-DRC unconnected item whose net is in a power class (`PWR_*` of the acceptance) or matches one of
 * `nets` (shell globs), a zone is added on the outer layer the two endpoints share (F.Cu/B.Cu; a through via counts as
 * either), covering both endpoints plus `margin`. KiCad's fill keeps every clearance, and never leaves copper thinner
 * than `min_thickness` = class track width x `minWidthScale`, so a pour connects only where the class current fits.
 * The geometry is KiCad's: this chooses only which nets, which layer and the covering rectangle. The caller scores the
 * board afterwards (the script re-applied the acceptance rules and ran A1-A9 with refilled DRC; the last-mile bench
 * does the same).
 */
import { randomUUID } from "node:crypto";
import { pyRound } from "../accept";
import type { Acceptance } from "../requirements";
import { appendBeforeClose } from "../layout/text";
import { quote } from "../sexpr";
import { powerWidths } from "./escape";

export interface UnconnectedItem {
  items: Array<{ description: string; pos?: { x: number; y: number } }>;
}

export interface PourOptions {
  /** More nets to pour, as shell globs (fnmatch). */
  nets?: string[];
  /** Margin round the two endpoints, mm (default 1.5). */
  margin?: number;
  /** min_thickness = class width x this (default 1.0); nets outside a power class count 0.3 mm. */
  minWidthScale?: number;
  uuid?: () => string;
}

export type PourRecord = { net: string; layer: string; box: [number, number, number, number]; min_thickness: number } | { net: string; skipped: string };

/** Python `fnmatch.fnmatchcase`: `*`, `?`, `[seq]`, `[!seq]`; everything else literal. */
export function fnmatch(name: string, pat: string): boolean {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const ch = pat[i]!;
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else if (ch === "[") {
      let j = i + 1;
      if (pat[j] === "!") j++;
      if (pat[j] === "]") j++;
      while (j < pat.length && pat[j] !== "]") j++;
      if (j >= pat.length) re += "\\[";
      else {
        let body = pat.slice(i + 1, j).replace(/\\/g, "\\\\");
        if (body.startsWith("!")) body = "^" + body.slice(1);
        else if (body.startsWith("^")) body = "\\" + body;
        re += `[${body}]`;
        i = j;
      }
    } else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  return new RegExp(`^(?:${re})$`, "s").test(name);
}

/** The outer layers an unconnected item's end is on, from its DRC description. */
export function layerOf(desc: string): Set<string> {
  if (/on F\.Cu - B\.Cu|on B\.Cu - F\.Cu/.test(desc)) return new Set(["F.Cu", "B.Cu"]);
  const m = / on ([FB])\.Cu/.exec(desc);
  return m ? new Set([`${m[1]}.Cu`]) : new Set();
}

/** Add the pours to a board's text for the open connections `unconnected` (native DRC `unconnected_items`). */
export function pourOpens(text: string, acc: Acceptance, unconnected: readonly UnconnectedItem[], o: PourOptions = {}): { text: string; made: PourRecord[] } {
  const margin = o.margin ?? 1.5;
  const scale = o.minWidthScale ?? 1.0;
  const globs = o.nets ?? [];
  const width = powerWidths(acc);
  const uuid = o.uuid ?? randomUUID;
  const made: PourRecord[] = [];
  let zones = "";
  for (const u of unconnected) {
    const it = u.items;
    const first = it[0], last = it[it.length - 1];
    if (!first || !last) continue;
    const net = /\[([^\]]+)\]/.exec(first.description)?.[1];
    if (net === undefined) continue;
    if (!width.has(net) && !globs.some((g) => fnmatch(net, g))) continue;
    const a = layerOf(first.description), b = layerOf(last.description);
    const layers = [...a].filter((l) => b.has(l));
    if (!layers.length) {
      made.push({ net, skipped: "endpoints share no outer layer" });
      continue;
    }
    const layer = layers.includes("B.Cu") ? "B.Cu" : "F.Cu";
    const xs = it.map((i) => i.pos?.x ?? 0), ys = it.map((i) => i.pos?.y ?? 0);
    const w = pyRound((width.get(net) ?? 0.3) * scale, 3);
    const box: [number, number, number, number] = [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin];
    zones += pourZone(net, layer, box, w, `pour_opens ${net}`, uuid());
    made.push({ net, layer, box: box.map((v) => pyRound(v, 3)) as [number, number, number, number], min_thickness: w });
  }
  return { text: zones ? appendBeforeClose(text, zones) : text, made };
}

function pourZone(net: string, layer: string, [x0, y0, x1, y1]: [number, number, number, number], width: number, name: string, id: string): string {
  const f4 = (x: number) => pyRound(x, 4).toFixed(4);
  const f3 = (x: number) => pyRound(x, 3).toFixed(3);
  const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => `(xy ${f4(x!)} ${f4(y!)})`).join(" ");
  return (
    `\n  (zone\n    (net ${quote(net)})\n    (layer ${quote(layer)})\n    (uuid "${id}")\n    (name ${quote(name)})\n` +
    `    (hatch edge 0.5)\n    (priority 1)\n    (connect_pads yes\n      (clearance 0.15))\n` +
    `    (min_thickness ${f3(width)})\n    (fill yes\n      (thermal_gap 0.25)\n      (thermal_bridge_width ${f3(width)})\n` +
    `      (island_removal_mode 0))\n    (polygon\n      (pts ${pts})))`
  );
}
