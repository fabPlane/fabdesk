import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  addNewCopper,
  autoAliases,
  boardPlan,
  convertTransforms,
  deriveGroups,
  dsnRules,
  escapeKeepouts,
  expandArgs,
  fixedRegex,
  footprintSpans,
  initFlow,
  lockFootprints,
  nameCopperNets,
  loadFlow,
  nextStep,
  parseSeeds,
  prepareLayout,
  pyReEscape,
  replaceCopper,
  runAuto,
  setPose,
  sesImport,
  stageCheck,
  stagePlace,
  stageRank,
  stageRoute,
  stripCopper,
  transferPoses,
  type LayoutHost,
  type ResourceKind,
} from "../src/layout/index";
import { onboard, parseBoard, readRequirements } from "../src/index";
import { SEAT_BOARD } from "./fixtures";

const fp = (ref: string, x: number, y: number, pads: Array<[string, string, number, number]>, rot = 0, crt = true) => `
	(footprint "Lib:${ref}"
		(layer "F.Cu")
		(at ${x} ${y} ${rot})
		(property "Reference" "${ref}" (at 0 0))
		(property "Value" "10k" (at 0 0))
		${crt ? '(fp_rect (start -1 -1) (end 1 1) (layer "F.CrtYd"))' : ""}
		${pads.map(([n, net, px, py]) => `(pad "${n}" smd rect (at ${px} ${py} ${rot}) (size 0.6 0.6) (layers "F.Cu" "F.Paste") (net "${net}"))`).join("\n")}
	)`;
const seg = (x1: number, net: string) => `\n	(segment (start ${x1} 0) (end ${x1 + 5} 0) (width 0.15) (layer "F.Cu") (net "${net}") (uuid "u${x1}"))`;
const BOARD = `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 60 40) (layer "Edge.Cuts"))
	${fp("J1", 5, 5, [["1", "VIN", 0, 0], ["2", "GND", 1, 0]])}
	${fp("U1", 30, 20, [["1", "USB_DP", 0, 0], ["2", "USB_DN", 1, 0], ["3", "VIN", 2, 0], ["4", "GND", 3, 0], ["5", "SIG", 4, 0], ["6", "EN", 5, 0]], 90)}
	${fp("R1", 20, 10, [["1", "SIG", -1, 0], ["2", "EN", 1, 0]])}
	${fp("R2", 22, 12, [["1", "SIG", -1, 0], ["2", "EN", 1, 0]])}
	${fp("R3", 24, 12, [["1", "SIG", -1, 0], ["2", "EN", 1, 0]])}
	${fp("J2", 50, 30, [["1", "USB_DP", 0, 0], ["2", "USB_DN", 1, 0]])}
	${seg(0, "VIN")}${seg(10, "USB_DP")}
	(via (at 3 3) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND"))
)`;
const PRO = JSON.stringify({
  net_settings: {
    classes: [
      { name: "Default", track_width: 0.15, clearance: 0.13, via_diameter: 0.5, via_drill: 0.3 },
      { name: "USB", track_width: 0.15, diff_pair_width: 0.15, diff_pair_gap: 0.2 },
    ],
    netclass_patterns: [{ pattern: "USB_*", netclass: "USB" }],
    netclass_assignments: {},
  },
  board: { design_settings: { rules: { min_track_width: 0.1, min_clearance: 0.1 } } },
});

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function tmp() {
  const d = await mkdtemp(join(tmpdir(), "layout-"));
  dirs.push(d);
  return d;
}

describe("board text edits", () => {
  test("footprint spans, pose and rotation of child angles", () => {
    const spans = footprintSpans(BOARD);
    expect([...spans.keys()]).toEqual(["J1", "U1", "R1", "R2", "R3", "J2"]);
    const [a, b] = spans.get("U1")!;
    const moved = setPose(BOARD.slice(a, b), 10, 11, 180);
    expect(moved).toContain("(at 10 11 180)");
    expect(moved).toContain("(at 0 0 180)"); // pad angles turn with the footprint (90 -> 180)
  });
  test("transfer copies poses and refuses a side change", () => {
    const placed = BOARD.replace("(at 20 10 0)", "(at 33 7 0)");
    const r = transferPoses(BOARD, placed, ["R1", "R2"]);
    expect(r.changed).toBe(1);
    expect(r.text).toContain("(at 33 7 0)");
    const flipped = placed.replace('(footprint "Lib:R1"\n\t\t(layer "F.Cu")', '(footprint "Lib:R1"\n\t\t(layer "B.Cu")');
    expect(() => transferPoses(BOARD, flipped, ["R1"])).toThrow("side change");
  });
  test("strip copper, lock, transforms", () => {
    const s = stripCopper(BOARD);
    expect(s.removed).toEqual({ segment: 2, via: 1 });
    expect(s.text).not.toContain("(segment");
    const locked = lockFootprints(s.text, ["J1"]);
    expect(locked.match(/\(locked yes\)/g)).toHaveLength(1);
    expect(lockFootprints(locked, ["J1"])).toBe(locked); // idempotent
    expect(convertTransforms('(footprint "x" (transform (translate 1 2) (rotate 90)))').text).toContain("(at 1 2 90)");
    expect(convertTransforms('(footprint "x"\n\t(transform\n\t\t(translate 1.5 2)\n\t\t(rotate -90)\n\t\t(scale 1 1)\n\t))').text).toContain("(at 1.5 2 -90)");
    expect(convertTransforms(BOARD).converted).toBe(0);
  });
  test("new copper is keyed by content and appended; replace swaps all copper", () => {
    const routed = BOARD.replace(/\)\s*$/, `\n\t(segment (start 1 1) (end 2 2) (width 0.15) (layer "F.Cu") (net "SIG") (uuid "new"))\n)`);
    const r = addNewCopper(BOARD, BOARD, routed);
    expect(r.stats["added_segments"]).toBe(1);
    expect(r.text.match(/\(segment/g)).toHaveLength(3);
    const rep = replaceCopper(BOARD, routed);
    expect(rep.stats["routed_items"]).toEqual({ segment: 3, via: 1, arc: 0 });
  });
  test("arcs inside polygon outlines are not routed copper: strip and replace leave them where they are", () => {
    const polyArc = "(arc (start 1 0) (mid 1.5 0.5) (end 2 0))";
    const fpPoly = `(fp_poly (pts (xy 0 0) ${polyArc} (xy 2 2)) (layer "F.Cu"))`;
    const padPoly = `(pad "1" smd custom (at 0 0) (size 0.5 0.5) (layers "F.Cu") (net "A") (primitives (gr_poly (pts (xy 0 0) ${polyArc} (xy 2 2)) (width 0))))`;
    const grPoly = `(gr_poly (pts (xy 10 10) (arc (start 11 10) (mid 11.5 10.5) (end 12 10)) (xy 12 12)) (layer "F.Cu") (net "A"))`;
    const track = `(arc (start 5 5) (mid 6 6) (end 7 5) (width 0.2) (layer "F.Cu") (net "A") (uuid "ta"))`;
    const sg = `(segment (start 0 0) (end 1 1) (width 0.2) (layer "F.Cu") (net "A") (uuid "s1"))`;
    const via = `(via (at 3 3) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "A") (uuid "v1"))`;
    const board = `(kicad_pcb (version 20250114)\n\t(footprint "X" (layer "F.Cu") (at 0 0)\n\t\t${fpPoly}\n\t\t${padPoly})\n\t${grPoly}\n\t${track}\n\t${sg}\n\t${via}\n)\n`;
    const s = stripCopper(board);
    expect(s.removed).toEqual({ segment: 1, via: 1, arc: 1 });
    expect(s.text).toContain(fpPoly);
    expect(s.text).toContain(padPoly);
    expect(s.text).toContain(grPoly);
    expect(s.text).not.toContain('(uuid "ta")');
    expect(s.text).not.toContain("(segment");
    // replace: the routed board's polygon arcs are not appended as stray top-level arcs; native ones stay put
    const routed = board.replace(sg, `(segment (start 0 0) (end 2 2) (width 0.2) (layer "F.Cu") (net "A") (uuid "s2"))`);
    const rep = replaceCopper(board, routed);
    expect(rep.stats["native_removed"]).toEqual({ segment: 1, via: 1, arc: 1 });
    expect(rep.stats["routed_items"]).toEqual({ segment: 1, via: 1, arc: 1 });
    expect(rep.text.split(polyArc)).toHaveLength(3); // the footprint's two, no more
    expect(rep.text).toContain(grPoly);
    expect(rep.text).toContain('(uuid "s2")');
    expect(rep.text).not.toContain('(uuid "s1")');
    expect(rep.text.match(/\n\(arc /g)).toHaveLength(1); // only the routed track arc lands at the top level
    // CRLF boards strip the same
    expect(stripCopper(board.replace(/\n/g, "\r\n")).removed).toEqual({ segment: 1, via: 1, arc: 1 });
  });
  test("numeric net references on copper become names", () => {
    const t = '(kicad_pcb\n\t(net 0 "")\n\t(net 7 "A B")\n\t(segment (start 0 0) (end 1 1) (width 0.1) (layer "F.Cu") (net 7) (uuid "x"))\n\t(zone (net 7))\n)';
    const r = nameCopperNets(t);
    expect(r.renamed).toBe(1);
    expect(r.text).toContain('(layer "F.Cu") (net "A B")');
    expect(r.text).toContain("(zone (net 7))");
    expect(nameCopperNets(BOARD).renamed).toBe(0);
  });
  test("SES import appends only new copper; DSN policy edit", () => {
    const layers8 = `(layers (0 "F.Cu" signal) ${[1, 2, 3, 4, 5, 6].map((n) => `(${2 + 2 * n} "In${n}.Cu" signal)`).join(" ")} (2 "B.Cu" signal) (25 "Edge.Cuts" user))`;
    const board = `(kicad_pcb\n\t${layers8}\n\t(segment (start 0 0) (end 5 0) (width 0.15) (layer "F.Cu") (net "A") (uuid "x"))\n)\n`;
    const ses = `(session x (routes (resolution um 10) (network_out (net A (wire (path F.Cu 1500 0 0 50000 0)) (wire (path F.Cu 1500 50000 0 50000 -50000)) (via "Via[0-7]_500:300_um" 50000 0)))))`;
    const r = sesImport(board, ses);
    expect(r.stats.skipped_existing_segments).toBe(1);
    expect(r.stats.segments).toBe(1);
    expect(r.stats.vias).toEqual({ "through:F.Cu-B.Cu": 1 });
    // the via's layers come from the board's own stack: [0-3] on a 4-layer board is through, [0-7] does not fit it
    const board4 = board.replace(layers8, '(layers (0 "F.Cu" signal) (4 "In1.Cu" signal) (6 "In2.Cu" signal) (2 "B.Cu" signal))');
    expect(sesImport(board4, ses.replace("Via[0-7]", "Via[0-3]")).stats.vias).toEqual({ "through:F.Cu-B.Cu": 1 });
    expect(sesImport(board4, ses.replace("Via[0-7]", "Via[0-1]")).stats.vias).toEqual({ "micro:F.Cu-In1.Cu": 1 });
    expect(() => sesImport(board4, ses)).toThrow("does not fit the board's 4 copper layers");
    expect(() => sesImport(board.replace(layers8, ""), ses)).toThrow("copper layers are unknown");
    expect(sesImport(board.replace(layers8, ""), ses, ["F.Cu", "In1.Cu", "In2.Cu", "In3.Cu", "In4.Cu", "In5.Cu", "In6.Cu", "B.Cu"]).stats.segments).toBe(1);
    const dsn = "(class PWR_1 A B\n (circuit\n  (use_via x))\n)\n(layer In1.Cu (type power))";
    expect(dsnRules(dsn, ["PWR_1"], ["In1.Cu"]).text).toContain("(use_layer F.Cu B.Cu)");
    expect(() => dsnRules(dsn, ["PWR_9"], [])).toThrow("missing class");
  });
});

describe("plans", () => {
  const acc = {
    schema: "x",
    stack_policy: { copper_layers: ["F.Cu", "In1.Cu", "B.Cu"], plane_layers: ["In1.Cu"], ground_net: "GND", via_spans: {} },
    net_classes: {
      tap_pads: { VIN: { "J1.1": { width: 0.3 } } },
      classes: {
        USB90: { layers: ["F.Cu", "B.Cu"], escape_layers: [], diff_pair_width: 0.15, diff_pair_gap: 0.2, pairs: [["A_P", "A_M"], ["B_P", "B_N"]] },
        PWR_1: { track_width: 0.5, inner_track_width: null, nets: ["VIN"] },
      },
    },
  } as never;
  test("auto aliases, macros and selectors", () => {
    const al = autoAliases(acc);
    expect(al.aliases).toHaveLength(1);
    const plan = boardPlan({ stages: [{ name: "pairs", tool: "route_diff", each_pair_class: true, args: ["--nets", "@pairs={class}", "--layers", "@pair-layers", "--layer-costs", "@pair-costs=5", "--track-width", "@pair-width"] }, { name: "all", tool: "route", args: ["--layers", "@layers"] }] }, acc);
    expect(plan.stages[0]!.name).toBe("pairs-usb90");
    expect(plan.stages[0]!.args).toEqual(["--nets", "@pairs=USB90", "--layers", "F.Cu", "B.Cu", "--layer-costs", "5", "5", "--track-width", "0.15"]);
    expect(plan.stages[1]!.args).toEqual(["--layers", "F.Cu", "B.Cu"]);
    const sel = { pairsToReroute: [["A_P", "A_M"]], cutNets: [], openBefore: [] };
    expect(expandArgs(["@pairs=USB90"], plan, acc, sel)).toEqual(["A_P", "A_N", "B_P", "B_N"]);
    expect(expandArgs(["@not-pairs", "@not-power"], plan, acc, sel)).toEqual(["!A_P", "!A_N", "!B_P", "!B_N", "!VIN"]);
    expect(expandArgs(["x", "@pairs-todo=USB90"], plan, acc, sel)).toEqual(["x", "A_P", "A_N"]);
    expect(expandArgs(["@cut-pairs=USB90"], plan, acc, sel)).toBeNull(); // nothing cut: the stage is skipped
    expect(expandArgs(["@tap-nets=0.3"], plan, acc, sel)).toEqual(["VIN"]);
  });
  test("python re.escape and seed lists", () => {
    expect(pyReEscape("kibuzzard-1 REF**")).toBe("kibuzzard\\-1\\ REF\\*\\*");
    expect(fixedRegex(["J1", "H-2"])).toBe("^(J1|H\\-2)$");
    expect(parseSeeds("0-2,5,9-10")).toEqual([0, 1, 2, 5, 9, 10]);
  });
});

describe("groups and keep-outs", () => {
  test("anchors collect the parts sharing their signal nets; fine-pitch fixed rows get fan-out room", () => {
    const b = parseBoard(BOARD);
    const g = deriveGroups(b, new Set(["J1", "J2"]));
    expect(g.find((x) => x.anchor === "U1")?.refs).toEqual(["R1", "R2", "R3", "U1"]);
    const pads = Array.from({ length: 12 }, (_, i) => ({ ref: "J9", pad: String(i), net: "N", x: i * 0.5, y: 10, r: 0.2, layers: ["F.Cu"] }));
    const ko = escapeKeepouts(pads, ["J9"]);
    expect(ko).toHaveLength(1);
    expect(ko[0]!.name).toBe("escape_J9_0");
    expect(ko[0]!.rect[0]).toBeCloseTo(-0.3, 6);
    expect(ko[0]!.note).toContain("12 pads at 0.50 mm pitch");
  });
});

// ------------------------------------------------------------------------------- the flow, with fake engines

type Calls = { admits: Array<{ kind: ResourceKind; label: string }>; spawns: string[][] };

/** Fake KRT/TraceMaker/KiCad: the stage logic runs for real, the engines write plausible files. */
function fakeHost(krt: string, opts: { tm?: boolean; courtyard?: (board: string) => Record<string, number>; open?: (board: string) => number; calls?: Calls } = {}): LayoutHost {
  const calls = opts.calls ?? { admits: [], spawns: [] };
  const openOf = opts.open ?? ((b) => ({ s0: 9, s1: 5, s2: 7, s3: 12 })[/s(\d)\//.exec(b)?.[0].slice(0, 2) ?? ""] ?? 20);
  return {
    tools: { krt, tracemaker: opts.tm ? join(krt, "..", "tracemaker") : null, kicadCli: "/fake/kicad-cli" },
    spawn: async (cmd, o) => {
      calls.spawns.push(cmd);
      const si = cmd.findIndex((c) => c.endsWith(".py"));
      const script = basename(cmd[si] ?? cmd[0]!);
      let log = "";
      if (script === "make_unplaced.py") await Bun.write(cmd[cmd.length - 2]!, await Bun.file(cmd[cmd.length - 3]!).text());
      else if (script === "check_floorplan.py") await Bun.write(cmd[cmd.length - 1]!, "{}");
      else if (script === "check_groups.py") log = "ok";
      else if (script === "place_simple.py") {
        const fixed = await Bun.file(cmd[si + 1]!).text();
        const tpl = cmd[si + 2]!;
        const range = cmd[cmd.indexOf("--seeds") + 1]!;
        for (const sd of parseSeeds(range)) {
          // every seed moves R1 by seed*2 mm; seed 3 writes no board
          const t = fixed.replace("(at 20 10 0)", `(at ${20 + sd * 2} 10 0)`);
          if (sd === 3) continue;
          await Bun.write(tpl.replace("{seed}", String(sd)), t);
          await Bun.write(join(tpl, "..", `s${sd}.log`), `noise\nJSON_SUMMARY:${JSON.stringify({ final: { crossings: 10 - sd, cost: 100 + sd, wire: 50 + sd } })}\n`);
        }
      } else if (script === "route.py" || script === "route_diff.py") {
        const [cur, nxt] = [cmd[si + 1]!, cmd[si + 2]!];
        const t = await Bun.file(cur).text();
        await Bun.write(nxt, t.replace(/\)\s*$/, `\n\t(segment (start 1 1) (end 2 ${script.length}) (width 0.15) (layer "F.Cu") (net "SIG") (uuid "r${Math.random()}"))\n)`));
      } else if (cmd[0]!.endsWith("/tracemaker")) {
        if (cmd[1] === "session") {
          const out = cmd[cmd.indexOf("--out") + 1]!;
          await Bun.write(out, (await Bun.file(cmd[2]!).text()).replace(/\)\s*$/, `\n\t(segment (start 3 3) (end 4 4) (width 0.15) (layer "F.Cu") (net "USB_DP") (uuid "tm1"))\n)`));
          await Bun.write(o.stdout!, [{ ok: true }, { routed: 2, open_after: 3 }, { ok: true }, { ok: true }].map((x) => JSON.stringify(x)).join("\n") + "\n");
        } else {
          await Bun.write(cmd[cmd.indexOf("-o") + 1]!, await Bun.file(cmd[2]!).text());
          log = "routed 4/5 nets\n";
        }
      }
      await Bun.write(o.log, log);
      return { code: 0, wallS: 0.1 };
    },
    courtyardDrc: async (board) => Object.entries((opts.courtyard ?? (() => ({})))(board)).flatMap(([rule, n]) => Array.from({ length: n as number }, () => ({ rule, items: [{ description: "Footprint R1 on F.Cu" }, { description: "Footprint R2 on F.Cu" }] }))),
    scoreDrc: async (board) => ({ violations: [], unconnected: openOf(board), parity: 0 }),
    admit: async (kind, label) => {
      calls.admits.push({ kind, label });
      return { release() {} };
    },
    memAvailableGiB: async () => 20,
    diskFreeGiB: async () => 100,
    tracemakerBusy: async () => false,
  };
}

async function project() {
  const dir = await tmp();
  await writeFile(join(dir, "board.kicad_pcb"), BOARD);
  await writeFile(join(dir, "board.kicad_pro"), PRO);
  await onboard(dir, { name: "t" });
  const krt = join(dir, "krt");
  await mkdir(join(krt, "src/plugins"), { recursive: true });
  await writeFile(join(dir, "tracemaker"), "#!/bin/sh\n");
  const prep = await prepareLayout(dir, { name: "t" });
  const ws = join(dir, "ws");
  return { dir, krt, prep, ws, st: await initFlow(ws, prep.spec, prep.specPath) };
}

describe("layout flow", () => {
  test("prepare writes a locked, copper-free base, groups and a spec", async () => {
    const { dir, prep } = await project();
    const base = await readFile(join(prep.spec.base, "board.kicad_pcb"), "utf8");
    expect(base).not.toContain("(segment");
    expect(base.match(/\(locked yes\)/g)?.length).toBe(prep.spec.fixed.split("|").length);
    expect(prep.spec.plans.rank).toBe("builtin:rank");
    const again = await prepareLayout(dir);
    expect(again.spec).toEqual(prep.spec);
  });

  test("prepare seats pair pass-through parts as templates, members in their chip's group", async () => {
    const dir = await tmp();
    await writeFile(join(dir, "board.kicad_pcb"), SEAT_BOARD);
    await writeFile(join(dir, "board.kicad_pro"), PRO);
    await onboard(dir, { name: "t" });
    const prep = await prepareLayout(dir, { name: "t" });
    expect(prep.spec.templates.map((t) => basename(t))).toEqual(["U1.row.json"]);
    const row = JSON.parse(await readFile(prep.spec.templates[0]!, "utf8")) as { anchor: string; members: Array<{ ref: string; rot: number }> };
    expect(row.anchor).toBe("U1");
    expect(row.members.map((m) => [m.ref, m.rot])).toEqual([["R2", 180], ["R1", 180]]);
    const groups = JSON.parse(await readFile(prep.spec.groups, "utf8")) as { groups: Array<{ anchor?: string; refs: string[] }> };
    expect(groups.groups.find((g) => g.anchor === "U1")?.refs).toEqual(expect.arrayContaining(["R1", "R2"]));
    expect(prep.decided.join("\n")).toContain("pair pass-through templates: U1: [\"R2\",\"R1\"]");
  });

  test("check passes, and says why it fails", async () => {
    const { krt, st } = await project();
    const ok = await stageCheck({ ...fakeHost(krt, { tm: true }), tools: { krt, tracemaker: join(krt, "..", "tracemaker"), kicadCli: "x" } }, st);
    expect(ok.verdict).toBe("PASS check");
    expect((ok.result as { info: Record<string, unknown> }).info).toMatchObject({ footprints: 6, fixed: 2, segments: 0, pairs: 1 });
    const bad = await stageCheck({ ...fakeHost(krt), tools: { krt: "/nonexistent", tracemaker: null, kicadCli: null } }, st);
    expect(bad.verdict).toStartWith("FAIL krt missing at /nonexistent");
    expect(bad.verdict).not.toContain("tracemaker"); // optional: installed only when chosen
    expect(bad.verdict).toContain("no KiCad CLI");
    expect((await loadFlow(st.ws)).stages.check?.status).toBe("fail");
    // KRT only (TraceMaker never chosen): the check passes and says the route stage goes without TraceMaker
    const krtOnly = await stageCheck({ ...fakeHost(krt), tools: { krt, tracemaker: null, kicadCli: "x" } }, st);
    expect(krtOnly.verdict).toBe("PASS check");
    expect(krtOnly.lines.join("\n")).toContain("WARN TraceMaker not installed: the route stage runs without its branch");
    // a TraceMaker path that is set but missing is still a failure
    expect((await stageCheck({ ...fakeHost(krt), tools: { krt, tracemaker: "/nonexistent/tracemaker", kicadCli: "x" } }, st)).verdict).toContain("tracemaker missing at /nonexistent/tracemaker");
    // an unlisted movable part and a part without a courtyard
    const prev = await readFile(join(st.ws, "base/board.kicad_pcb"), "utf8");
    await writeFile(join(st.ws, "base/board.kicad_pcb"), prev.replace('(fp_rect (start -1 -1) (end 1 1) (layer "F.CrtYd"))', ""));
    const noCrt = await stageCheck(fakeHost(krt, { tm: true }), st);
    expect(noCrt.verdict).toContain("parts without courtyard: ['J1'");
  });

  test("check installs a missing engine through the host first; a failed install is named in the verdict", async () => {
    const { krt, st } = await project();
    const asked: string[] = [];
    const tm = join(krt, "..", "tracemaker");
    const host = { ...fakeHost(krt, { tm: true }), tools: { krt: null, tracemaker: null, kicadCli: "x" }, ensure: async (e: "krt" | "tracemaker") => (asked.push(e), { path: e === "krt" ? krt : tm }) };
    expect((await stageCheck(host, st)).verdict).toBe("PASS check");
    expect(asked).toEqual(["krt", "tracemaker"]);
    expect(host.tools).toMatchObject({ krt, tracemaker: tm });
    // a set path (an override) is checked as given: no install
    const set = { ...fakeHost(krt), tools: { krt: "/nonexistent", tracemaker: tm, kicadCli: "x" }, ensure: async () => ({ path: "/should-not-be-used" }) };
    expect((await stageCheck(set, st)).verdict).toStartWith("FAIL krt missing at /nonexistent ->");
    const failed = { ...fakeHost(krt), tools: { krt: null, tracemaker: tm, kicadCli: "x" }, ensure: async () => ({ path: null, why: "offline: cannot download https://x" }) };
    expect((await stageCheck(failed, st)).verdict).toContain("krt missing at (not installed) (offline: cannot download https://x)");
  });

  test("place gates every seed on native courtyard DRC and fixed parts unmoved", async () => {
    const { krt, st } = await project();
    const host = fakeHost(krt, { tm: true, courtyard: (b) => (b.includes("/s1/") ? { courtyards_overlap: 2 } : {}) });
    await expect(stagePlace(host, st, { seeds: "0-3" })).rejects.toThrow("run check first");
    await stageCheck(host, st);
    const p = await stagePlace(host, st, { seeds: "0-3" });
    expect(p.verdict).toBe("PASS place 2/4 gated, 2 kept for rank");
    const seeds = (p.result as { seeds: Array<{ seed: number; gate: boolean; why: string; kept?: boolean }> }).seeds;
    expect(seeds.map((s) => [s.seed, s.gate])).toEqual([[0, true], [1, false], [2, true], [3, false]]);
    expect(seeds[1]!.why).toBe('courtyard {"courtyards_overlap":2}');
    expect(seeds[3]!.why).toBe("placer wrote no board");
    expect(seeds.filter((s) => s.kept).map((s) => s.seed).sort()).toEqual([0, 2]);
    const rec = JSON.parse(await readFile(join(st.ws, "place/seeds-0-3/place.json"), "utf8"));
    expect(rec.locked_fixed).toEqual(["J1", "J2"]);
    expect(rec.seeds["2"].placer).toEqual({ crossings: 8, cost: 102, wire: 52 });
    const placed = await readFile(join(st.ws, "place/seeds-0-3/s2/placed/board.kicad_pcb"), "utf8");
    expect(placed).toContain("(at 24 10 0)"); // R1 moved by the placer's pose, copied back onto the native board
    expect(JSON.parse(await readFile(join(st.ws, "place/result.json"), "utf8")).verdict).toBe(p.verdict);
  });

  test("place STOPs when no seed passes the gates", async () => {
    const { krt, st } = await project();
    const host = fakeHost(krt, { tm: true, courtyard: () => ({ courtyards_overlap: 1 }) });
    await stageCheck(host, st);
    const p = await stagePlace(host, st, { seeds: "0-1" });
    expect(p.verdict).toStartWith("STOP no seed passed the gates");
    expect(nextStep(await loadFlow(st.ws)).text).toContain("blocked at place");
  });

  test("rank orders by open connections, route keeps the best, TraceMaker runs alone", async () => {
    const { krt, st } = await project();
    const calls: Calls = { admits: [], spawns: [] };
    const host = fakeHost(krt, { tm: true, calls, open: (b) => (b.includes("/rank/s0/") ? 9 : b.includes("/rank/s1/") ? 5 : b.includes("/rank/s2/") ? 7 : b.includes("tm-f") ? 3 : b.includes("/route/tm/") ? 4 : 6) });
    await stageCheck(host, st);
    await stagePlace(host, st, { seeds: "0-2" });
    const r = await stageRank(host, st, { jobs: 2 });
    expect(r.verdict).toBe("PASS rank best seed 1 open 5");
    const route = await stageRoute(host, st);
    const res = route.result as Record<string, { open: number } | null>;
    expect(res["tm"]?.open).toBe(4);
    expect(res["tm-f-g"]?.open).toBe(3);
    expect(route.verdict).toStartWith("PASS route best open 3");
    expect(route.board).toEndWith("/board.kicad_pcb");
    const tmAdmits = calls.admits.filter((a) => a.kind === "tracemaker");
    expect(tmAdmits).toHaveLength(1);
    expect(calls.admits.filter((a) => a.kind === "router").length).toBeGreaterThanOrEqual(3 + 4);
    // the session request file names the pair nets and closes the plane layers
    const reqs = (await readFile(join(st.ws, "route/tm/tm/requests.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(reqs.map((x) => x.tool)).toEqual(["board_info", "route", "check", "save"]);
    expect(reqs[1].args.nets).toEqual(["USB_DP", "USB_DN"]);
    // a board with no plane layers has no --no-tracks-on (TraceMaker rejects an empty layer list)
    expect(calls.spawns.find((c) => c[1] === "route")).not.toContain("--no-tracks-on");
    const krtCommands = calls.spawns.filter(c => c.some(arg => /route(?:_diff|_planes)?\.py$/.test(arg)));
    expect(krtCommands.length).toBeGreaterThan(0);
    for (const cmd of krtCommands) expect(cmd).toContain("--same-net-pad-clearance");
    // the finished flow hands the board to the last mile
    const flow = await loadFlow(st.ws);
    expect(flow.best_board?.open).toBe(3);
    expect(nextStep(flow).text).toContain("layout done");
  });

  test("route STOPs when too many connections stay open, and skips TraceMaker when it is not installed", async () => {
    const { krt, st } = await project();
    const host = fakeHost(krt, { tm: false, open: () => 40 });
    await stageCheck(fakeHost(krt, { tm: true }), st);
    await stagePlace(host, st, { seeds: "0-1" });
    await stageRank(host, st, {});
    const route = await stageRoute(host, st);
    expect(route.verdict).toStartWith("STOP best open 40 > 25: placement problem");
    expect((route.result as Record<string, unknown>)["tm_skipped"]).toBe("TraceMaker is not installed");
    const file = JSON.parse(await readFile(join(st.ws, "route/result.json"), "utf8"));
    expect(file.status).toBe("stop");
  });

  test("auto stops at the first FAIL/STOP and skips passed stages", async () => {
    const { krt, st } = await project();
    const host = fakeHost(krt, { tm: true, courtyard: () => ({ courtyards_overlap: 1 }) });
    const r = await runAuto(host, st, { seeds: "0-1" });
    expect(r.ran.map((x) => x.stage)).toEqual(["check", "place"]);
    expect(r.stopped?.verdict).toStartWith("STOP");
    const ok = await runAuto(fakeHost(krt, { tm: true }), st, { seeds: "0-1", until: "place" });
    expect(ok.ran.map((x) => x.stage)).toEqual(["place"]); // check had passed
    expect(ok.stopped).toBeNull();
  });

  test("a stage's records are plain files an agent can read", async () => {
    const { krt, st } = await project();
    await stageCheck(fakeHost(krt, { tm: true }), st);
    const names = await readdir(join(st.ws, "check"));
    expect(names).toContain("result.json");
    expect((await readRequirements(st.spec.requirements.replace(/\/\.fabdesk.*/, "")))?.acceptance.schema).toBeTruthy();
  });
});

describe("DSN export", () => {
  test("runs kicad-cli specctra and applies the layer policy", async () => {
    const { exportDsn } = await import("../src/layout/index");
    const dir = await tmp();
    const calls: string[][] = [];
    const host = {
      spawn: async (cmd: string[], o: { log: string }) => {
        calls.push(cmd);
        await writeFile(cmd[cmd.indexOf("-o") + 1]!, "(class PWR_1 A B\n (circuit\n  (use_via x))\n)\n(layer In1.Cu (type power))");
        await writeFile(o.log, "");
        return { code: 0, wallS: 0 };
      },
    };
    const r = await exportDsn(host, "/k/kicad-cli", join(dir, "b.kicad_pcb"), join(dir, "b.dsn"), { outerOnly: ["PWR_1"], planeLayers: ["In1.Cu"] });
    expect(calls[0]!.slice(1, 4)).toEqual(["pcb", "export", "specctra"]);
    expect(r.done).toEqual(["PWR_1"]);
    expect(await readFile(r.dsn, "utf8")).toContain("(use_layer F.Cu B.Cu)");
  });
});
