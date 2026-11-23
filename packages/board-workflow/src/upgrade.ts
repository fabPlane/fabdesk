/**
 * The toolkit's `pcb upgrade` (tools/boardformat.py): bring a board saved by KiCad 9 or older (copper names its net by
 * number, `(net 12)`) to the current format, on a copy, and say what changed.
 *
 * The workflow matches copper by net name, so on a pre-10 board a move cut no copper and every copper check passed on
 * nothing (held-out cm5_minima, 2026-11-11); the stages refuse such a board. `upgradeCopy` copies the board into a folder,
 * rewrites it with KiCad (`kicad-cli pcb upgrade --force`, boards only: KiCad's schematic upgrade renamed hierarchical
 * nets on cm5_minima, a board-only upgrade keeps parity) and checks the copy item by item against the original: every
 * footprint pad, track, via, arc and zone keeps its net. KiCad re-derives the net of copper that touches other copper on
 * load; when that changed any item's net, the copy is named in place instead (`nameBoardNets`: each item gets the name its
 * number had, nothing else changes) and the changes KiCad would have made are reported. The caller decides whether the
 * copy replaces the owner's board.
 */
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { legacyNetRefs, parseBoard } from "./board";
import { copperItems, nameCopperNets, topLevel } from "./layout/text";

const VERSION = /\(version (\d+)\)/;

export function boardVersion(text: string): number | null {
  const m = VERSION.exec(text.slice(0, 400));
  return m ? Number(m[1]) : null;
}

/** `(net N "NAME")` declarations of a pre-10 board: number -> name. */
function netTable(text: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const m of text.matchAll(/^\s*\(net (\d+) "((?:[^"\\]|\\.)*)"\)\s*$/gm)) table.set(m[1]!, m[2]!);
  return table;
}

interface CopperNet {
  kind: string;
  id: string;
  net: string;
  at: string;
}

/** Every top-level copper item (segment, via, arc, zone) with its net by name; a numbered net is looked up in the table. */
export function copperNets(text: string): CopperNet[] {
  const table = netTable(text);
  const items = [...copperItems(text).map(({ kind, span }) => ({ kind: kind as string, span })), ...topLevel(text, "zone").map((span) => ({ kind: "zone", span }))];
  return items.map(({ kind, span }, i) => {
    const b = text.slice(...span);
    const named = /\(net_name "((?:[^"\\]|\\.)*)"\)/.exec(b) ?? /\(net "((?:[^"\\]|\\.)*)"\)/.exec(b);
    const num = /\(net (\d+)\)/.exec(b);
    const net = named ? named[1]! : num ? (table.get(num[1]!) ?? `#${num[1]}`) : "";
    const id = /\(uuid "?([^")\s]+)"?\)/.exec(b)?.[1] ?? `${kind}#${i}`;
    const at = /\((?:start|at) ([-\d.]+) ([-\d.]+)/.exec(b);
    return { kind, id, net, at: at ? `${at[1]},${at[2]}` : "" };
  });
}

/**
 * Pure-text upgrade of the net references: every segment, via and arc names its net (`nameCopperNets`) and every zone's
 * `(net N) (net_name "X")` becomes `(net "X")`. Nothing else changes (the version line stays).
 */
export function nameBoardNets(text: string): { text: string; renamed: number } {
  const cu = nameCopperNets(text);
  let renamed = cu.renamed;
  const parts: string[] = [];
  let at = 0;
  for (const [a, b] of topLevel(cu.text, "zone")) {
    const zone = cu.text.slice(a, b).replace(/\(net \d+\)(\s*)\(net_name ("(?:[^"\\]|\\.)*")\)/, (_m, _ws: string, name: string) => {
      renamed++;
      return `(net ${name})`;
    });
    parts.push(cu.text.slice(at, a), zone);
    at = b;
  }
  parts.push(cu.text.slice(at));
  return { text: parts.join(""), renamed };
}

/** What differs between two versions of one board: pads whose net changed, copper items whose net changed, items gone or new. */
export function netDifferences(before: string, after: string): string[] {
  const out: string[] = [];
  const pa = parseBoard(before).footprints;
  const pb = parseBoard(after).footprints;
  for (const [ref, f] of pa) {
    const g = pb.get(ref);
    if (!g) {
      out.push(`footprint ${ref} missing`);
      continue;
    }
    for (const [pad, net] of Object.entries(f.pins)) if (g.pins[pad] !== net) out.push(`pad ${ref}.${pad}: ${net || "(none)"} -> ${g.pins[pad] ?? "(gone)"}`);
  }
  for (const ref of pb.keys()) if (!pa.has(ref)) out.push(`footprint ${ref} new`);
  const ca = copperNets(before);
  const cb = new Map(copperNets(after).map((c) => [`${c.kind}:${c.id}`, c]));
  for (const c of ca) {
    const d = cb.get(`${c.kind}:${c.id}`);
    if (!d) out.push(`${c.kind} @ ${c.at} (${c.net}) gone`);
    else if (d.net !== c.net) out.push(`${c.kind} @ ${c.at}: ${c.net || "(none)"} -> ${d.net || "(none)"}`);
    cb.delete(`${c.kind}:${c.id}`);
  }
  for (const d of cb.values()) out.push(`${d.kind} @ ${d.at} (${d.net}) new`);
  return out;
}

export interface UpgradeReport {
  /** The upgraded copy. */
  board: string;
  method: "kicad" | "names" | "none";
  versionBefore: number | null;
  versionAfter: number | null;
  /** Copper items that named their net by number, before and after. */
  legacyBefore: number;
  legacyAfter: number;
  /** Net references rewritten by the text method. */
  renamed: number;
  /** Item nets KiCad's upgrade would have changed (then the text method was used instead). */
  kicadChanges: string[];
  /** One line per change, for the report. */
  changed: string[];
}

/**
 * Upgrade a copy of `pcb` into `outDir` (created). `kicad` runs `kicad-cli pcb upgrade --force` on the copy; without it,
 * or when KiCad's result changes any item's net, the copy is named in place (`nameBoardNets`). Throws when the copy
 * still names a net by number or differs from the original in any net.
 */
export async function upgradeCopy(pcb: string, outDir: string, opts: { kicad?: (file: string) => Promise<void> } = {}): Promise<UpgradeReport> {
  const before = await readFile(pcb, "utf8");
  await mkdir(outDir, { recursive: true });
  const copy = join(outDir, basename(pcb));
  const legacyBefore = legacyNetRefs(before);
  const vBefore = boardVersion(before);
  if (!legacyBefore) {
    await copyFile(pcb, copy);
    return { board: copy, method: "none", versionBefore: vBefore, versionAfter: vBefore, legacyBefore: 0, legacyAfter: 0, renamed: 0, kicadChanges: [], changed: [] };
  }
  let kicadChanges: string[] = [];
  if (opts.kicad) {
    await copyFile(pcb, copy);
    await opts.kicad(copy);
    const after = await readFile(copy, "utf8");
    kicadChanges = netDifferences(before, after);
    if (!kicadChanges.length && !legacyNetRefs(after)) {
      const vAfter = boardVersion(after);
      return {
        board: copy,
        method: "kicad",
        versionBefore: vBefore,
        versionAfter: vAfter,
        legacyBefore,
        legacyAfter: 0,
        renamed: 0,
        kicadChanges: [],
        changed: [`rewritten by KiCad in the current format (version ${vBefore ?? "?"} -> ${vAfter ?? "?"}); ${legacyBefore} copper item(s) now name their net; every pad, track, via, arc and zone kept its net`],
      };
    }
  }
  const named = nameBoardNets(before);
  const legacyAfter = legacyNetRefs(named.text);
  const diff = netDifferences(before, named.text);
  if (legacyAfter || diff.length)
    throw new Error(`upgrading ${basename(pcb)} left ${legacyAfter} numbered net reference(s) and ${diff.length} changed net(s)${diff.length ? `: ${diff.slice(0, 6).join("; ")}` : ""}; upgrade it in KiCad (open and save) instead`);
  await writeFile(copy, named.text);
  const changed = [`${named.renamed} copper item(s) now name their net (text rewrite; version line ${vBefore ?? "?"} kept, every other byte as saved)`];
  if (kicadChanges.length)
    changed.push(`KiCad's own upgrade would have changed ${kicadChanges.length} item net(s) (copper touching copper of another net; KiCad re-derives it on load), so the board was not rewritten by KiCad: ${kicadChanges.slice(0, 8).join("; ")}${kicadChanges.length > 8 ? `; ... ${kicadChanges.length - 8} more` : ""}`);
  return { board: copy, method: "names", versionBefore: vBefore, versionAfter: vBefore, legacyBefore, legacyAfter: 0, renamed: named.renamed, kicadChanges, changed };
}
