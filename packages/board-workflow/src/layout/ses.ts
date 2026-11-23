/**
 * Specctra SES result merged onto a native board as new copper (port of `ses_import.py`), and the DSN policy edit
 * (`dsn_rules.py`). The DSN itself is exported with `kicad-cli pcb export specctra` (no pcbnew).
 */
import { randomUUID } from "node:crypto";
import { parseSexpr, kids, type SNode } from "../sexpr";
import { topLevel } from "./text";

export interface SesStats {
  segments: number;
  vias: Record<string, number>;
  skipped_existing_segments: number;
  skipped_existing_vias: number;
  protected_skipped: number;
}

const q = (s: string) => JSON.stringify(s);

function existingCopper(board: string) {
  const segs = new Map<string, Array<[number, number, number, number]>>();
  const vias = new Set<string>();
  // board-level items only (spans, not a free regex over the file): no lazy match can run on into the next item
  const segRe = /^\(segment\s+\(start ([-\d.]+) ([-\d.]+)\)\s+\(end ([-\d.]+) ([-\d.]+)\)\s+\(width [-\d.]+\)\s+\(layer "([^"]+)"\)\s+\(net "((?:[^"\\]|\\.)*)"\)/;
  for (const [a, b] of topLevel(board, "segment")) {
    const m = segRe.exec(board.slice(a, b));
    if (!m) continue;
    const k = `${m[5]}\u0000${m[6]}`;
    (segs.get(k) ?? segs.set(k, []).get(k)!).push([Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  for (const [a, b] of topLevel(board, "via")) {
    const body = board.slice(a, b);
    const at = /^\(via(?:\s+\w+)?\s+\(at ([-\d.]+) ([-\d.]+)\)/.exec(body);
    const net = /\(net "((?:[^"\\]|\\.)*)"\)/.exec(body);
    if (at && net) vias.add(`${Math.round(Number(at[1]) * 1000) / 1000},${Math.round(Number(at[2]) * 1000) / 1000},${net[1]}`);
  }
  return { segs, vias };
}

/**
 * The board's copper layers in stack order (F.Cu, In1.Cu .. InN.Cu, B.Cu) from its `(layers ...)` table; empty when
 * the board has no table.
 */
export function boardCopperLayers(board: string): string[] {
  const table = topLevel(board, "layers")[0];
  if (!table) return [];
  const names = [...board.slice(...table).matchAll(/\(\s*\d+\s+"?((?:F|B|In\d+)\.Cu)"?/g)].map((m) => m[1]!);
  const rank = (l: string) => (l === "F.Cu" ? 0 : l === "B.Cu" ? 1e6 : Number(/^In(\d+)/.exec(l)![1]));
  return [...new Set(names)].sort((x, y) => rank(x) - rank(y));
}

function onSegment(p: [number, number], s: [number, number, number, number], tol = 0.002): boolean {
  const [x, y] = p;
  const [x1, y1, x2, y2] = s;
  const dx = x2 - x1, dy = y2 - y1;
  const L = dx * dx + dy * dy;
  const t = L === 0 ? 0 : Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / L));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) <= tol;
}

export function viaKind(padstack: string, layers: readonly string[]): { kind: "through" | "micro" | "blind"; l1: string; l2: string; d: number; h: number } {
  const m = /^Via\[(\d+)-(\d+)\]_(\d+):(\d+)_um/.exec(padstack);
  if (!m) throw new Error("unknown via padstack " + padstack);
  const [a, b, d, h] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  const last = layers.length - 1;
  if (b > last || a >= b) throw new Error(`via padstack ${padstack} does not fit the board's ${layers.length} copper layers`);
  const kind = a === 0 && b === last ? "through" : b - a === 1 && (a === 0 || a === last - 1) ? "micro" : "blind";
  return { kind, l1: layers[a]!, l2: layers[b]!, d: d / 1000, h: h / 1000 };
}

const isProtected = (n: SNode) => n.some((x) => Array.isArray(x) && x[0] === "type" && x[1] === "protect");

/**
 * Existing copper stays byte-exact; only SES wires and vias not already present are appended. Via padstacks
 * (`Via[a-b]_...`) name copper layers by index, so the stack must be the board's: `layers` (stack order) when given,
 * else the board's own `(layers ...)` table. A board without either, a via index past the stack, or a wire on a layer
 * the stack lacks is refused (the toolkit assumed an 8-layer stack and mislabelled vias on any other board).
 */
export function sesImport(board: string, sesText: string, layers?: readonly string[]): { text: string; stats: SesStats } {
  const stack = layers ?? boardCopperLayers(board);
  if (stack.length < 2) throw new Error("SES import: the board's copper layers are unknown (no (layers ...) table and none given)");
  const ses = parseSexpr(sesText);
  const routes = kids(ses, "routes")[0]!;
  const res = kids(routes, "resolution")[0]!;
  const unit = { um: 1e-3, mm: 1, mil: 0.0254, inch: 25.4 }[String(res[1])];
  if (unit === undefined) throw new Error("unknown SES resolution unit " + String(res[1]));
  const scale = unit / Number(res[2]);
  const { segs, vias } = existingCopper(board);
  const out: string[] = [];
  const stats: SesStats = { segments: 0, vias: {}, skipped_existing_segments: 0, skipped_existing_vias: 0, protected_skipped: 0 };
  for (const net of kids(kids(routes, "network_out")[0]!, "net")) {
    const name = String(net[1]);
    for (const w of kids(net, "wire")) {
      if (isProtected(w)) {
        stats.protected_skipped++;
        continue;
      }
      for (const path of kids(w, "path")) {
        const layer = String(path[1]);
        if (!stack.includes(layer)) throw new Error(`SES import: wire on ${layer}, not a copper layer of this ${stack.length}-layer board`);
        const width = Number(path[2]) * scale;
        const pts: Array<[number, number]> = [];
        for (let i = 3; i < path.length - 1; i += 2) pts.push([Number(path[i]) * scale, -Number(path[i + 1]) * scale]);
        for (let i = 0; i + 1 < pts.length; i++) {
          const p1 = pts[i]!, p2 = pts[i + 1]!;
          if (p1[0] === p2[0] && p1[1] === p2[1]) continue;
          if ((segs.get(`${layer}\u0000${name}`) ?? []).some((s) => onSegment(p1, s) && onSegment(p2, s))) {
            stats.skipped_existing_segments++;
            continue;
          }
          out.push(`  (segment (start ${p1[0].toFixed(4)} ${p1[1].toFixed(4)}) (end ${p2[0].toFixed(4)} ${p2[1].toFixed(4)}) (width ${width.toFixed(4)}) (layer ${q(layer)}) (net ${q(name)}) (uuid ${q(randomUUID())}))`);
          stats.segments++;
        }
      }
    }
    for (const v of kids(net, "via")) {
      if (isProtected(v)) {
        stats.protected_skipped++;
        continue;
      }
      const x = Number(v[2]) * scale, y = -Number(v[3]) * scale;
      if (vias.has(`${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000},${name}`)) {
        stats.skipped_existing_vias++;
        continue;
      }
      const k = viaKind(String(v[1]), stack);
      const head = k.kind === "through" ? "(via" : `(via ${k.kind}`;
      const fill = k.kind === "through" ? "" : " (capping yes) (filling yes)";
      out.push(`  ${head} (at ${x.toFixed(4)} ${y.toFixed(4)}) (size ${k.d}) (drill ${k.h}) (layers ${q(k.l1)} ${q(k.l2)})${fill} (net ${q(name)}) (uuid ${q(randomUUID())}))`);
      const key = `${k.kind}:${k.l1}-${k.l2}`;
      stats.vias[key] = (stats.vias[key] ?? 0) + 1;
    }
  }
  const text = board.slice(0, board.trimEnd().lastIndexOf(")")).trimEnd() + "\n" + out.join("\n") + "\n)\n";
  return { text, stats };
}

/**
 * Apply the acceptance's layer policy to a KiCad DSN export: power classes with no inner width (F/B only) get
 * `(use_layer F.Cu B.Cu)`, since KiCad's DSN has no per-layer width. Returns the classes edited.
 */
export function dsnRules(dsn: string, outerOnly: string[], planeLayers: string[]): { text: string; done: string[] } {
  let text = dsn;
  const done: string[] = [];
  for (const name of outerOnly) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(String.raw`(\(class ` + esc + String.raw`[,\s][^()]*\(circuit\s*\n)`, "s");
    if (re.test(text)) {
      text = text.replace(re, (_m, g1: string) => g1 + "        (use_layer F.Cu B.Cu)\n");
      done.push(name);
    }
  }
  for (const layer of planeLayers) {
    const esc = layer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(String.raw`\(layer ` + esc + String.raw`\s+\(type power\)`).test(text)) throw new Error(`${layer} is not a power layer in the DSN`);
  }
  if (done.length !== outerOnly.length) throw new Error("missing class in DSN");
  return { text, done };
}

export interface DsnExportHost {
  spawn: (cmd: string[], o: { log: string }) => Promise<{ code: number; wallS: number }>;
}

/**
 * Export a Specctra DSN with `kicad-cli pcb export specctra` (the toolkit used pcbnew's ExportSpecctraDSN; the CLI writes the
 * same file without a Python/pcbnew runtime), then apply the acceptance's layer policy (`dsnRules`): F/B-only power classes
 * get `(use_layer F.Cu B.Cu)`. Returns the policy DSN's text path and the classes edited.
 */
export async function exportDsn(host: DsnExportHost, kicadCli: string, board: string, outDsn: string, acc: { outerOnly: string[]; planeLayers: string[] }): Promise<{ dsn: string; done: string[] }> {
  const { readFile, writeFile } = await import("node:fs/promises");
  const r = await host.spawn([kicadCli, "pcb", "export", "specctra", "-o", outDsn, board], { log: outDsn + ".log" });
  if (r.code) throw new Error(`kicad-cli pcb export specctra exited ${r.code} (see ${outDsn}.log)`);
  const policy = outDsn.replace(/\.dsn$/, "") + "-policy.dsn";
  const { text, done } = dsnRules(await readFile(outDsn, "utf8"), acc.outerOnly, acc.planeLayers);
  await writeFile(policy, text);
  return { dsn: policy, done };
}
