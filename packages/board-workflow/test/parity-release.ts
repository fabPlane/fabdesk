/**
 * Release-stage parity: the toolkit's Python oracle against @fabdesk/board-workflow's release and silk libraries.
 *
 *   bun packages/board-workflow/test/parity-release.ts --board DIR --out DIR [--toolkit DIR] [--kicad-cli PATH]
 *       [--silk-boards a=PCB,b=PCB] [--packages C6=DIR/rel,R1N=DIR/rel]
 *
 * Not part of `bun run test` (needs the Python toolkit, its gerbonara venv, inkscape, kicad-cli, and the network for the
 * first BOM lookup). Both BOM runs read the same evidence cache (the Python run fetches, the TypeScript run replays it),
 * so the comparison is of the interpretation, not of the suppliers' answers on the day. Writes parity-release.json and
 * release-parity.md into --out.
 */
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { parseSexpr, release, silk } from "../src/index";

const { values: a } = parseArgs({
  options: {
    board: { type: "string" },
    out: { type: "string" },
    toolkit: { type: "string", default: "/home/shane/pcb-worktrees/heldout" },
    "kicad-cli": { type: "string", default: "/usr/bin/kicad-cli-nightly" },
    "gerb-python": { type: "string", default: "/home/shane/.local/share/pcb-toolkit/gerb-venv/bin/python" },
    "silk-boards": { type: "string", default: "" },
    packages: { type: "string", default: "C6=/home/shane/vaio_p_modding/io-c6/release/C6-eco95-fab103,R1N=/home/shane/vaio_p_modding/io-c6/release/R1N-q701-fab103" },
  },
});
if (!a.board || !a.out) throw new Error("--board and --out are required");
const out = a.out;
const tk = a.toolkit!;
const cli = { path: a["kicad-cli"]!, version: "" };
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const proj = join(out, "proj");
await mkdir(proj, { recursive: true });
for (const n of await readdir(a.board)) if (/\.(kicad_pcb|kicad_pro|kicad_sch|kicad_sym|kicad_dru)$|^(fp|sym)-lib-table$/.test(n) || n.endsWith(".pretty")) await cp(join(a.board, n), join(proj, n), { recursive: true });
const pcb = join(proj, (await readdir(proj)).find((n) => n.endsWith(".kicad_pcb"))!);
const stem = pcb.replace(/^.*\//, "").replace(/\.kicad_pcb$/, "");

async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { env: { ...process.env, PCB_SELFRECORD: "off" }, stdout: "pipe", stderr: "pipe" });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  return { code, out: o, err: e };
}

const rows: Array<{ item: string; agree: boolean; detail: unknown }> = [];
const rec = (item: string, agree: boolean, detail: unknown = "") => {
  rows.push({ item, agree, detail });
  console.log(`${agree ? "AGREE " : "DIFFER"} ${item}`, agree ? "" : JSON.stringify(detail).slice(0, 300));
};

function diff(x: unknown, y: unknown, path: string, acc: string[], ignore: ReadonlySet<string> = new Set()): void {
  if (typeof x === "number" && typeof y === "number") {
    if (Math.abs(x - y) > 1e-9 * Math.max(1, Math.abs(x))) acc.push(`${path}: ${x} != ${y}`);
  } else if (Array.isArray(x) && Array.isArray(y)) {
    if (x.length !== y.length) acc.push(`${path}: length ${x.length} != ${y.length}`);
    for (let i = 0; i < Math.min(x.length, y.length); i++) diff(x[i], y[i], `${path}[${i}]`, acc, ignore);
  } else if (x && y && typeof x === "object" && typeof y === "object") {
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (ignore.has(k)) continue;
      if (!(k in x)) acc.push(`${path}.${k}: only in oracle`);
      else if (!(k in y)) acc.push(`${path}.${k}: only in TS`);
      else diff((x as never)[k], (y as never)[k], `${path}.${k}`, acc, ignore);
    }
  } else if (x !== y) acc.push(`${path}: ${JSON.stringify(x)} != ${JSON.stringify(y)}`);
}

// ---------------------------------------------------------------- BOM
const pyBom = join(out, "py-bom");
const t0 = Date.now();
const pb = await sh(["python3", join(tk, "flow/bomcheck.py"), proj, stem, pyBom]);
const pySecs = (Date.now() - t0) / 1000;
if (pb.code) throw new Error(pb.err.slice(-1500));
const tsBom = join(out, "ts-bom");
await cp(join(pyBom, "cache"), join(tsBom, "cache"), { recursive: true });
const t1 = Date.now();
const tsRes = await release.bomCheck({ project: proj, stem, out: tsBom, offline: true });
const tsSecs = (Date.now() - t1) / 1000;
const pyDec = JSON.parse(await readFile(join(pyBom, "bom-decisions.json"), "utf8"));
const tsDec = JSON.parse(await readFile(join(tsBom, "bom-decisions.json"), "utf8"));
const d1: string[] = [];
// the reason text names the toolkit's own command for a proposal; the TS text names the stage: wording only
const norm = (j: any) => JSON.parse(JSON.stringify(j).replace(/\(edit\.py swap fields\)|\(edit swap fields\)/g, "(swap fields)"));
diff(norm(pyDec), norm(tsDec), "bom", d1, new Set(["fetch_calls"]));
rec("bomcheck: bom-decisions.json (every record, field for field)", d1.length === 0, d1.slice(0, 6));
const csvOf = async (f: string) => (await readFile(f, "utf8")).trim().split(/\r?\n/).map((l) => l.split(","));
const cplA = (await csvOf(join(pyBom, "cpl-jlc.csv"))).slice(1), cplB = (await csvOf(join(tsBom, "cpl-jlc.csv"))).slice(1);
const cplBad = cplA.filter((r, i) => r[0] !== cplB[i]?.[0] || r[1] !== cplB[i]?.[1] || r[2] !== cplB[i]?.[2] || Math.abs(Number(r[3]) - Number(cplB[i]?.[3])) > 1e-9 || Math.abs(Number(r[4]) - Number(cplB[i]?.[4])) > 1e-9 || Math.abs(Number(r[5]) - Number(cplB[i]?.[5])) > 1e-9);
rec(`bomcheck: CPL rows (${cplA.length} Python, ${cplB.length} TS: ref, LCSC, side, KiCad rotation, JLC offset, JLC rotation)`, cplA.length === cplB.length && cplBad.length === 0, cplBad.slice(0, 4));
rec("bomcheck: swap-fields.json", JSON.stringify(JSON.parse(await readFile(join(pyBom, "swap-fields.json"), "utf8"))) === JSON.stringify(JSON.parse(await readFile(join(tsBom, "swap-fields.json"), "utf8"))));
rec("bomcheck: summary, lines, placements, rotation offsets, bottom placements", JSON.stringify([pyDec.summary, pyDec.lines, pyDec.placements, pyDec.rotation_offsets, pyDec.bottom_side_placements]) === JSON.stringify([tsRes.summary, tsRes.lines, tsRes.placements, tsRes.rotation_offsets, tsRes.bottom_side_placements]), { py: pyDec.summary, ts: tsRes.summary });

// ---------------------------------------------------------------- CAM, gerbcheck, JLC package, jlcsim
const gdir = join(out, "gerbers");
await release.exportCam(cli, pcb, gdir, release.requiredLayers(await readFile(pcb, "utf8")));
const gcT = Date.now();
const gcTs = await release.gerbCheck({ gerbers: gdir, pcb, out: join(out, "ts-gerbcheck"), cli, dpi: 400 });
const gcTsSecs = (Date.now() - gcT) / 1000;
const gcP = Date.now();
const gcPyRun = await sh(["python3", join(tk, "flow/gerbcheck.py"), gdir, pcb, join(out, "py-gerbcheck"), "--dpi", "400", "--venv", a["gerb-python"]!]);
const gcPySecs = (Date.now() - gcP) / 1000;
const gcPy = JSON.parse(await readFile(join(out, "py-gerbcheck", "gerbcheck.json"), "utf8"));
const layerRows = Object.keys(gcPy.layers).map((k) => ({ layer: k, py: gcPy.layers[k], ts: gcTs.layers[k] }));
rec(`gerbcheck: verdict per layer (${layerRows.length} layers)`, layerRows.every((r) => r.ts && r.py.pass === r.ts.pass) && Object.keys(gcTs.layers).length === layerRows.length && gcPy.pass === gcTs.pass, layerRows.filter((r) => r.py.pass !== r.ts?.pass));
rec("gerbcheck: drill files, tools and holes per file", JSON.stringify(Object.entries(gcPy.drill).sort()) === JSON.stringify(Object.entries(gcTs.drill).sort()), { py: gcPy.drill, ts: gcTs.drill });
// mutations: both readers must see them
const mutations: Array<{ name: string; layer: string; edit: (t: string) => string }> = [
  { name: "a pad flash moved 0.3 mm", layer: "F_Cu", edit: (t) => t.replace(/(%TO\.P[^\n]*\n(?:[^\n]*\n)*?)X(\d+)(Y-?\d+D03\*)/, (_m, p: string, x: string, y: string) => `${p}X${Number(x) + 300000}${y}`) },
  { name: "the first long track removed", layer: "B_Cu", edit: (t) => { const m = /\nX(\d+)Y(-?\d+)D02\*\nX(\d+)Y(-?\d+)D01\*/g; for (const x of t.matchAll(m)) if (Math.hypot(Number(x[1]) - Number(x[3]), Number(x[2]) - Number(x[4])) > 8e6) return t.replace(x[0], "\n"); return t; } },
];
for (const mu of mutations) {
  const md = join(out, `mut-${mu.layer}`);
  await cp(gdir, md, { recursive: true });
  const f = (await readdir(md)).find((n) => n.includes(`-${mu.layer}.`))!;
  const text = await readFile(join(md, f), "latin1");
  const bent = mu.edit(text);
  if (bent === text) { rec(`gerbcheck mutation (${mu.name}): applied`, false, "edit did not apply"); continue; }
  await writeFile(join(md, f), bent, "latin1");
  const t = await release.gerbCheck({ gerbers: md, pcb, out: join(out, `ts-gc-mut-${mu.layer}`), cli, dpi: 400 });
  await sh(["python3", join(tk, "flow/gerbcheck.py"), md, pcb, join(out, `py-gc-mut-${mu.layer}`), "--dpi", "400", "--venv", a["gerb-python"]!]);
  const p = JSON.parse(await readFile(join(out, `py-gc-mut-${mu.layer}`, "gerbcheck.json"), "utf8"));
  rec(`gerbcheck mutation (${mu.name} on ${mu.layer}): both readers give the same verdict (Python ${p.layers[mu.layer].pass ? "pass" : "FAIL"}, TS ${t.layers[mu.layer]!.pass ? "pass" : "FAIL"}; beyond 1 px: ${p.layers[mu.layer].beyond_1px} / ${t.layers[mu.layer]!.beyond_1px})`, p.layers[mu.layer].pass === t.layers[mu.layer]!.pass, { py: p.layers[mu.layer], ts: t.layers[mu.layer] });
}

// the JLC package: positions from the pos file, copper from the Gerbers
const pkg = join(out, "pkg");
await mkdir(join(pkg, "gerbers"), { recursive: true });
for (const n of await readdir(gdir)) if (/-(F_Cu|B_Cu)\./.test(n)) { await cp(join(gdir, n), join(pkg, "gerbers", n)); await cp(join(gdir, n), join(pkg, "gerbers", `${stem}-${/F_Cu/.test(n) ? "F_Cu" : "B_Cu"}.gbr`)); }
await sh([cli.path, "pcb", "export", "pos", "--output", join(pkg, `${stem}-pos.csv`), "--format", "csv", "--units", "mm", "--side", "both", pcb]);
const jf = await release.jlcFiles(pkg, tsBom, stem, join(pkg, "gerbers"));
const sheets = await Promise.all((await readdir(proj)).filter((n) => n.endsWith(".kicad_sch")).sort().map((n) => readFile(join(proj, n), "utf8")));
const simTs = await release.placementCheck(pkg, tsBom, stem, sheets);
const pySim = await sh(["python3", "-c", `import sys,json; sys.path.insert(0,'${tk}/flow'); sys.path.insert(0,'${tk}/tools'); import jlcsim
v=jlcsim.verify('${pkg}','${pyBom}/cache','${stem}','${proj}')
print(json.dumps({'summary':v['summary'],'parts':v['parts']}))`]);
const simPy = JSON.parse(pySim.out.trim().split("\n").pop()!);
const d2: string[] = [];
diff(simPy, { summary: simTs.summary, parts: simTs.parts }, "sim", d2);
rec(`jlcsim on the ${stem} package (${simPy.summary.placements} placements, ${simPy.summary.pass} pass): summary and every part, field for field`, d2.length === 0, d2.slice(0, 6));
rec(`JLC package files: ${jf.bom_lines} BOM lines, ${jf.placements} CPL rows, ${jf.rotation_differs_from_kicad.length} rotations differ from KiCad, ${jf.moved_to_pad_centre.length} positions moved to the pad centre`, jf.placements === simPy.summary.placements);

// packages from the toolkit's own releases: C6 (275 placements, proxies) and R1N (110): the `--proxies` check
const pkgNotes: string[] = [];
for (const spec of (a.packages ?? "").split(",").filter(Boolean)) {
  const [name, dir] = spec.split("=") as [string, string];
  const p = join(dir, "package");
  const stemP = (await readdir(p)).find((n) => n.endsWith("-jlc-cpl.csv"))!.replace(/-jlc-cpl\.csv$/, "");
  const proxies = Object.fromEntries(Object.entries(JSON.parse(await readFile(join(dir, "jlc-footprint-proxies.json"), "utf8"))).filter(([k]) => !k.startsWith("_"))) as never;
  const maps = async (l: string) => release.gerberPads(release.parseGerber(await readFile(join(p, "gerbers", (await readdir(join(p, "gerbers"))).find((n) => n.includes(`-${l}.`))!), "latin1")));
  const codes: Record<string, string> = {};
  for (const r of release.parseCsv(await readFile(join(p, `${stemP}-jlc-bom.csv`), "utf8"))) for (const d of r["Designator"]!.split(",")) codes[d.trim()] = r["LCSC Part #"]!;
  const ts = release.simulatePlacement({ cpl: release.parseCsv(await readFile(join(p, `${stemP}-jlc-cpl.csv`), "utf8")) as never, codes, top: await maps("F_Cu"), bottom: await maps("B_Cu"), proxies, eda: (c) => { try { return JSON.parse(require("node:fs").readFileSync(join(dir, "bom", "cache", `eda-${c}.json`), "utf8")); } catch { return null; } } });
  const py = JSON.parse((await sh(["python3", "-c", `import sys,json; sys.path.insert(0,'${tk}/flow'); sys.path.insert(0,'${tk}/tools'); import jlcsim
px={k:x for k,x in json.load(open('${dir}/jlc-footprint-proxies.json')).items() if not k.startswith('_')}
v=jlcsim.verify('${p}','${dir}/bom/cache','${stemP}',None,proxies=px)
print(json.dumps({'summary':v['summary'],'parts':v['parts']}))`])).out.trim().split("\n").pop()!);
  const d: string[] = [];
  diff(py, { summary: ts.summary, parts: ts.parts }, name, d);
  pkgNotes.push(`${name}: ${py.summary.placements} placements, ${py.summary.pass} pass, ${py.summary.fail} fail, ${py.summary.checked_with_proxy_footprint.length} with a proxy footprint`);
  rec(`jlcsim --proxies on the toolkit's ${name} package (${py.summary.placements} placements, ${py.summary.checked_with_proxy_footprint.length} proxied, ${py.summary.fail} fail): every part, field for field`, d.length === 0, d.slice(0, 6));
}

// ---------------------------------------------------------------- via bindings
const pcbText = await readFile(pcb, "utf8");
const vTs = release.viaBindings(pcb, release.classifyVias(pcbText));
const vPy = await sh(["python3", join(tk, "flow/viaproc.py"), pcb, join(out, "py-via.json")]);
const viaPy = JSON.parse(await readFile(join(out, "py-via.json"), "utf8"));
const d3: string[] = [];
diff({ counts: viaPy.counts, bindings: viaPy.bindings }, { counts: vTs.record.counts, bindings: vTs.record.bindings }, "via", d3);
rec(`viaproc: ${viaPy.counts.vias} vias, ${viaPy.counts.via_in_pad} in pads, ${viaPy.counts.require_fill_cap} need fill+cap: counts and every binding`, d3.length === 0, d3.slice(0, 4));

// ---------------------------------------------------------------- silk
const silkRows: string[] = [];
const silkBoards = (a["silk-boards"] ?? "").split(",").filter(Boolean).map((s) => s.split("=") as [string, string]);
silkBoards.unshift(["cm5_minima", pcb]);
for (const [name, file] of silkBoards) {
  const wd = join(out, `silk-${name}`);
  await mkdir(wd, { recursive: true });
  const bdir = join(wd, "board");
  await mkdir(bdir, { recursive: true });
  await cp(file, join(bdir, "b.kicad_pcb"));
  const text = await readFile(join(bdir, "b.kicad_pcb"), "utf8");
  const m = await silk.buildSilkModel(text, { cli, workDir: join(wd, "w") });
  const v = silk.judge(m, silk.planOf());
  await sh(["python3", join(tk, "flow/silk.py"), "check", join(bdir, "b.kicad_pcb"), "--json", join(wd, "py-check.json")]);
  const py = JSON.parse(await readFile(join(wd, "py-check.json"), "utf8"));
  const kinds = (rs: Array<{ ref: string; issues: Array<{ kind: string }> }>) => new Map(rs.map((r) => [r.ref, r.issues.map((i) => i.kind).sort().join("+")]));
  const [pk, tk2] = [kinds(py.rows), kinds(v.rows)];
  const rowDiff = [...new Set([...pk.keys(), ...tk2.keys()])].filter((r) => pk.get(r) !== tk2.get(r));
  const totals = (["labels", "wanted", "clean", "bad", "texts", "texts_bad"] as const).every((k) => (v as never)[k] === py[k]);
  const labelCats = (c: Record<string, number>) => JSON.stringify(Object.entries(c).filter(([k]) => !k.startsWith("outline-")).sort());
  rec(`silk check ${name}: labels ${py.labels}, clean ${py.clean}, bad ${py.bad}, wanted ${py.wanted}, free texts ${py.texts} (${py.texts_bad} bad): totals`, totals, { py: [py.labels, py.clean, py.bad, py.wanted], ts: [v.labels, v.clean, v.bad, v.wanted] });
  rec(`silk check ${name}: label issue counts (${Object.entries(py.counts).filter(([k]) => !k.startsWith("outline-")).map(([k, n]) => `${k} ${n}`).join(", ")})`, labelCats(py.counts) === labelCats(v.counts), { py: py.counts, ts: v.counts });
  rec(`silk check ${name}: footprint-silk-against-copper counts (outline-*: polygon sampling decides borderline touches), rows differing ${rowDiff.length} of ${Math.max(pk.size, tk2.size)}`, JSON.stringify(Object.entries(py.counts).sort()) === JSON.stringify(Object.entries(v.counts).sort()), { py: py.counts, ts: v.counts, rows: rowDiff.slice(0, 5) });
  silkRows.push(`${name}: py ${JSON.stringify(py.counts)} | ts ${JSON.stringify(v.counts)} | rows differing ${rowDiff.length}/${Math.max(pk.size, tk2.size)}`);
  const ts0 = Date.now();
  const tsPlace = await silk.silkPlace({ pcb: join(bdir, "b.kicad_pcb"), out: join(wd, "ts-place"), cli, pictures: false });
  const tsPlaceSecs = (Date.now() - ts0) / 1000;
  const p0 = Date.now();
  await sh(["python3", join(tk, "flow/silk.py"), "place", join(bdir, "b.kicad_pcb"), join(wd, "py-place"), "--no-pictures", "--json", join(wd, "py-place.json")]);
  const pySecs = (Date.now() - p0) / 1000;
  const pp = JSON.parse(await readFile(join(wd, "py-place.json"), "utf8"));
  const [boxA, boxB] = [silk.readSilkParts(parseSexpr(await readFile(join(wd, "ts-place", "b.kicad_pcb"), "utf8"))).parts, silk.readSilkParts(parseSexpr(await readFile(join(wd, "py-place", "b.kicad_pcb"), "utf8"))).parts];
  let same = 0;
  const differ: string[] = [];
  for (const ref of Object.keys(boxB)) {
    const x = boxA[ref]!.label, y = boxB[ref]!.label;
    const ok = x.visible === y.visible && (!x.visible || Math.max(...x.box.map((q, i) => Math.abs(q - y.box[i]!))) < 0.02);
    if (ok) same++; else differ.push(ref);
  }
  const nowhere = tsPlace.fit_nowhere.join() === pp.fit_nowhere.join();
  silkRows.push(`${name} place: TS ${tsPlace.placed}/${tsPlace.wanted} placed, ${tsPlace.fit_nowhere.length} fit nowhere, after bad ${tsPlace.after.bad} (${tsPlaceSecs.toFixed(1)} s) | Python ${pp.placed}/${pp.wanted}, ${pp.fit_nowhere.length}, bad ${pp.after.bad} (${pySecs.toFixed(1)} s) | labels at the same place ${same}/${Object.keys(boxB).length}; fit-nowhere lists equal ${nowhere}; only labels changed ${tsPlace.only_labels_changed}`);
  rec(`silk place ${name}: placed / wanted / fit nowhere / after-check problems (TS ${tsPlace.placed}/${tsPlace.wanted}/${tsPlace.fit_nowhere.length}/${tsPlace.after.bad}, Python ${pp.placed}/${pp.wanted}/${pp.fit_nowhere.length}/${pp.after.bad})`, tsPlace.placed === pp.placed && tsPlace.wanted === pp.wanted && tsPlace.fit_nowhere.length === pp.fit_nowhere.length && tsPlace.after.bad === pp.after.bad && tsPlace.only_labels_changed, { differ: differ.slice(0, 8), nowhere });
  rec(`silk place ${name}: every label at the oracle's place (within 0.02 mm)`, differ.length === 0, { same, differ: differ.slice(0, 10) });
}

await writeFile(join(out, "parity-release.json"), JSON.stringify({ rows, timing: { pyBomSecs: pySecs, tsBomSecs: tsSecs, gcTsSecs, gcPySecs }, gerbcheck: { py: layerRows.map((r) => ({ layer: r.layer, py_beyond_1px: r.py.beyond_1px, ts_beyond_1px: r.ts?.beyond_1px, py_pass: r.py.pass, ts_pass: r.ts?.pass })) }, packages: pkgNotes, silk: silkRows }, null, 1));
const md = [
  `# Release stage parity (generated by parity-release.ts)`,
  ``,
  `| item | agrees | detail |`,
  `|---|---|---|`,
  ...rows.map((r) => `| ${r.item} | ${r.agree ? "yes" : "**NO**"} | ${r.agree ? "" : "`" + JSON.stringify(r.detail).slice(0, 200).replace(/\|/g, "/") + "`"} |`),
  ``,
  `Timing: BOM check Python ${pySecs.toFixed(1)} s (live lookups) / TS ${tsSecs.toFixed(2)} s (replaying the cache); gerbcheck Python ${gcPySecs.toFixed(1)} s / TS ${gcTsSecs.toFixed(1)} s.`,
  ``,
  `## gerbcheck per layer (pixels beyond the 1-pixel band, 400 dpi)`,
  ``,
  `| layer | Python | TS | Python pass | TS pass |`,
  `|---|---|---|---|---|`,
  ...layerRows.map((r) => `| ${r.layer} | ${r.py.beyond_1px} | ${r.ts?.beyond_1px} | ${r.py.pass} | ${r.ts?.pass} |`),
  ``,
  `## packages (jlcsim)`,
  ...pkgNotes.map((n) => `- ${n}`),
  ``,
  `## silk`,
  ...silkRows.map((n) => `- ${n}`),
].join("\n");
await writeFile(join(out, "release-parity.md"), md + "\n");
console.log(`\n${rows.filter((r) => r.agree).length}/${rows.length} rows agree`);
