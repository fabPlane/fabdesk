/**
 * Placement parity: the toolkit's placement_check.py and block_inventory.py (the oracles) against layout/placement.ts and
 * layout/blocks.ts on real boards.
 *
 *   bun packages/board-workflow/test/parity-placement.ts --out DIR [--toolkit DIR]
 *
 * Not part of `bun run test` (needs the Python toolkit with numpy; no router, no kicad-cli). C6 runs the toolkit's files
 * unchanged. The toolkit hard-codes C6 (outline 74.9 x 65.4 at the origin, ground IO_GND, fixed `_(J|SW)\d|^FIT_`, the
 * C6 height screen); for cm5 and vme a copy of the script gets the board's values in their place, the same substitution
 * the TypeScript takes as options, and nothing else. Compared: the whole output JSON (numbers equal after JSON parse).
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { placementCheck } from "../src/layout/placement";
import { parseBoard } from "../src/board";
import { blockInventory } from "../src/layout/blocks";
import { deriveGroups } from "../src/layout/spec";
import { footprintSpans, pose, setPose } from "../src/layout/text";

const { values: a } = parseArgs({ options: { out: { type: "string" }, toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" }, only: { type: "string" } } });
if (!a.out) throw new Error("--out is required");
const out = a.out;
const tools = join(a.toolkit!, "tools");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

interface Case {
  name: string;
  board: string;
  blocks?: string;
  /** null: run the toolkit unchanged (C6). */
  patch: null | { fixed: string; ground: string; outline: [number, number, number, number]; heights: string; project: string };
  split?: string[];
  /** Turn these parts first (written to a copy): exercises the rotation flags. */
  turn?: Record<string, number>;
}

const spec = async (p: string) => JSON.parse(await readFile(p, "utf8")) as { fixed: string; requirements: string };
const ground = async (req: string) => (JSON.parse(await readFile(join(req, "acceptance.json"), "utf8")) as { stack_policy: { ground_net: string } }).stack_policy.ground_net;
const edge = (text: string): [number, number, number, number] => {
  const o = parseBoard(text).outline!;
  return [o.minX, o.minY, o.maxX, o.maxY];
};

const C6P = "/home/shane/vaio_p_modding/io-c6";
const cases: Case[] = [
  { name: "c6-placed-E2", board: "/home/shane/vaio-io-fresh/work/c6-route85/placed-E2/C6.kicad_pcb", blocks: `${C6P}/review/c6-route85/blocks.json`, patch: null, split: ["C18-io", "A74-sv-test-battery-a7.4", "C6-integration"] },
  { name: "c6-release", board: `${C6P}/C6/C6.kicad_pcb`, blocks: `${C6P}/review/c6-floorplan84/blocks.json`, patch: null, split: ["A74-sv-test-battery-a7.4", "C6-integration"] },
];
cases.push({ ...cases[0]!, name: "c6-turned", turn: { A74_U9: 180, A74_U10: 90, C18_IC201: 270, A74_U1: 90 } });
for (const [name, dir, sp] of [
  ["cm5", "/home/shane/pcb-cmp/cm5_minima/proj2", "/home/shane/pcb-cmp/cm5_minima/onboard/spec.json"],
  ["vme", "/home/shane/pcb-cmp/vme-wren/proj2", "/home/shane/pcb-cmp/vme-wren/onboard3/spec.json"],
] as const) {
  const s = await spec(sp);
  const board = join(dir, "board.kicad_pcb");
  cases.push({ name, board, patch: { fixed: s.fixed, ground: await ground(s.requirements), outline: edge(await readFile(board, "utf8")), heights: join(s.requirements, "heights.json"), project: dir }, split: name === "cm5" ? ["USB", "IO", "CM5_MINIMA_3", "PCIe-M2"] : ["power-supply-1", "clocks", "io_driver", "ddr4-ps"] });
}
cases.push({ ...cases.find((c) => c.name === "cm5")!, name: "cm5-turned", turn: { U405: 180, U702: 90, U401: 270 } });

async function run(cmd: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(cmd, { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (code) throw new Error(`${cmd.join(" ")}: exit ${code}\n${e.slice(-1500)}`);
  return o;
}

const pyStr = (s: string) => JSON.stringify(s);
/** placement_check.py with the board's values in place of C6's (the same substitution the TS options make). */
function patchPlacement(src: string, p: NonNullable<Case["patch"]>): string {
  const [x0, y0, x1, y1] = p.outline;
  const rep = (s: string, from: string, to: string) => {
    if (!s.includes(from)) throw new Error(`patch: ${from} not found`);
    return s.replace(from, to);
  };
  let s = src;
  s = rep(s, "FIXED = re.compile(r'_(J|SW)\\d|^FIT_')", `FIXED = re.compile(${pyStr(p.fixed)})`);
  s = rep(s, "SKIP = re.compile(r'^IO_GND$|^unconnected-')", `SKIP = re.compile(${pyStr(`^${p.ground.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$|^unconnected-`)})`);
  s = rep(s, "nx, ny = int(74.9 / cell), int(65.4 / cell)", `X0, Y0, X1, Y1 = ${x0}, ${y0}, ${x1}, ${y1}\n    nx, ny = int((X1 - X0) / cell), int((Y1 - Y0) / cell)`);
  s = rep(s, "gx = (np.arange(nx) + 0.5) * cell; gy = (np.arange(ny) + 0.5) * cell", "gx = X0 + (np.arange(nx) + 0.5) * cell; gy = Y0 + (np.arange(ny) + 0.5) * cell");
  s = rep(s, "free = (GX > 0.6) & (GX < 74.3) & (GY > 0.6) & (GY < 64.8)", "free = (GX > X0 + 0.6) & (GX < X1 - 0.6) & (GY > Y0 + 0.6) & (GY < Y1 - 0.6)");
  s = rep(s, "blocks[f'{i * cell:.0f},{j * cell:.0f}']", "blocks[f'{X0 + i * cell:.0f},{Y0 + j * cell:.0f}']");
  return s;
}

const compare: unknown[] = [];
const rows: Array<{ item: string; agree: boolean; detail?: unknown }> = [];
const record = (item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ item, agree, ...(agree ? {} : { detail }) });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 1200));
};
/** First differing path of two JSON values. */
function diff(x: unknown, y: unknown, path = ""): string | null {
  if (typeof x !== typeof y || Array.isArray(x) !== Array.isArray(y)) return `${path}: ${JSON.stringify(x)?.slice(0, 200)} vs ${JSON.stringify(y)?.slice(0, 200)}`;
  if (x && typeof x === "object") {
    const kx = Object.keys(x as object), ky = Object.keys(y as object);
    if (kx.join() !== ky.join()) return `${path}: keys ${kx.slice(0, 30).join(",")} vs ${ky.slice(0, 30).join(",")}`;
    for (const k of kx) {
      const d = diff((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return x === y || (Number.isNaN(x) && Number.isNaN(y)) ? null : `${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`;
}

for (const c of cases) {
  if (a.only && !c.name.includes(a.only)) continue;
  const d = join(out, c.name);
  await mkdir(d, { recursive: true });
  let text = await readFile(c.board, "utf8");
  if (c.turn) {
    for (const [ref, deg] of Object.entries(c.turn)) {
      const sp = footprintSpans(text).get(ref);
      if (!sp) throw new Error(`${c.name}: no ${ref}`);
      const body = text.slice(sp[0], sp[1]);
      const [x, y, r] = pose(body);
      text = text.slice(0, sp[0]) + setPose(body, x, y, r + deg) + text.slice(sp[1]);
    }
    c.board = join(d, "turned.kicad_pcb");
    await writeFile(c.board, text);
  }
  // ---- placement_check
  let script = join(tools, "placement_check.py");
  if (c.patch) {
    script = join(d, "placement_check.py");
    await writeFile(script, patchPlacement(await readFile(join(tools, "placement_check.py"), "utf8"), c.patch));
  }
  const pyOut = join(d, "placement-py.json");
  const t0 = Date.now();
  await run(["python3", script, c.board, pyOut, ...(c.blocks ? ["--blocks", c.blocks] : [])], { PYTHONPATH: tools });
  const pyS = (Date.now() - t0) / 1000;
  const py = JSON.parse(await readFile(pyOut, "utf8").then((s) => s.replace(/\bNaN\b/g, "null")));
  const t1 = Date.now();
  const ts = placementCheck(text, {
    board: c.board,
    ...(c.blocks ? { blocks: JSON.parse(await readFile(c.blocks, "utf8")) } : {}),
    ...(c.patch ? { fixed: new RegExp(c.patch.fixed), ground: c.patch.ground, outline: c.patch.outline } : { outline: [0, 0, 74.9, 65.4] }),
  });
  const tsS = (Date.now() - t1) / 1000;
  await writeFile(join(d, "placement-ts.json"), JSON.stringify(ts, null, 1) + "\n");
  // A zero-saving tie (the best turn's HPWL equals the current one to the reported 0.1 mm and saves 0.000): which turn the
  // toolkit names is float noise (its costs differ in the last bit, e.g. 77.780004 vs 77.78000399999999 for C18_FL202),
  // and a tie never flags. The turn is compared everywhere else; ties are counted.
  let ties = 0;
  const tsj = JSON.parse(JSON.stringify(ts));
  const tie = (x: Record<string, unknown> | undefined) => !!x && x["saving"] === 0 && x["hpwl_best_mm"] === x["hpwl_now_mm"];
  py.rotation.all.forEach((x: Record<string, unknown>, i: number) => {
    const y = tsj.rotation.all[i] as Record<string, unknown> | undefined;
    if (y && x["ref"] === y["ref"] && x["best_turn_deg"] !== y["best_turn_deg"] && tie(x) && tie(y)) ((x["best_turn_deg"] = y["best_turn_deg"] = "tie"), ties++);
  });
  const dd = diff(py, tsj);
  record(`${c.name} placement_check (py ${pyS.toFixed(1)} s, ts ${tsS.toFixed(1)} s; ${ts.nets} nets, ${ts.rotation.checked} rotation candidates, ${ts.rotation.flagged.length} flagged, ${ties} zero-saving ties named differently)`, !dd, dd);
  // ---- block_inventory
  if (c.turn) continue;
  let bscript = join(tools, "block_inventory.py");
  if (c.patch) {
    bscript = join(d, "block_inventory.py");
    let src = await readFile(join(tools, "block_inventory.py"), "utf8");
    const rep = (from: string, to: string) => {
      if (!src.includes(from)) throw new Error(`patch: ${from} not found`);
      src = src.replace(from, to);
    };
    rep("(ROOT / 'requirements/component-height-screens.json')", `Path(${pyStr(c.patch.heights)})`);
    rep("p['net'] != 'IO_GND'", `p['net'] != ${pyStr(c.patch.ground)}`);
    rep("re.match(r'.*_(U|IC)\\d', r)", "re.match(r'(.*_)?(U|IC)\\d', r)");
    await writeFile(bscript, src);
  }
  const bpy = join(d, "blocks-py.json");
  await run(["python3", bscript, c.board, bpy, "--split", ...(c.split ?? [])], { PYTHONPATH: tools });
  const pyb = JSON.parse(await readFile(bpy, "utf8"));
  const heightsFile = c.patch ? c.patch.heights : `${C6P}/requirements/component-height-screens.json`;
  const tsb = blockInventory(text, {
    split: c.split ?? [],
    heights: (JSON.parse(await readFile(heightsFile, "utf8")) as { entries: Array<{ ref: string; height_above_surface_mm?: number }> }).entries,
    ...(c.patch ? { ground: c.patch.ground, anchor: /^(.*_)?(U|IC)\d/ } : {}),
  });
  await writeFile(join(d, "blocks-ts.json"), JSON.stringify(tsb, null, 1) + "\n");
  const bd = diff(pyb, JSON.parse(JSON.stringify(tsb)));
  record(`${c.name} block_inventory split [${(c.split ?? []).join(", ")}] (${Object.keys(tsb).length} blocks)`, !bd, bd);
  // ---- the inventory's claim that deriveGroups replaces block_inventory: how the two partitions relate
  const fixedRe = c.patch ? new RegExp(c.patch.fixed) : /_(J|SW)\d|^FIT_/;
  const board = parseBoard(text);
  const groups = deriveGroups(board, new Set([...board.footprints.keys()].filter((r) => fixedRe.test(r))));
  const blockOf = new Map(Object.entries(tsb).flatMap(([b, v]) => v.parts.map((r) => [r, b] as const)));
  let pure = 0, total = 0;
  for (const g of groups) {
    const cnt = new Map<string, number>();
    for (const r of g.refs) cnt.set(blockOf.get(r) ?? "?", (cnt.get(blockOf.get(r) ?? "?") ?? 0) + 1);
    pure += Math.max(...cnt.values());
    total += g.refs.length;
  }
  compare.push({ board: c.name, blocks: Object.keys(tsb).length, derive_groups: groups.length, parts_in_groups: total, parts_in_majority_block: pure, purity: Math.round((pure / Math.max(1, total)) * 1000) / 1000 });
  console.log(`       ${c.name}: deriveGroups ${groups.length} groups vs ${Object.keys(tsb).length} blocks; ${pure}/${total} grouped parts share their group's majority block`);
}

await writeFile(join(out, "parity.json"), JSON.stringify({ rows, derive_groups_vs_blocks: compare }, null, 1) + "\n");
const bad = rows.filter((r) => !r.agree).length;
console.log(`${rows.length - bad}/${rows.length} agree`);
process.exit(bad ? 1 : 0);
