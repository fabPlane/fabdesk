import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copperBoard, netFacts, widthFloors, widthCheck, krtPatternMatches, saveWidthBaseline, referenceFacts, krtWidthArgs, allowWidthChange, classWidthFloors, compareQuality, quality } from "../src/routing-quality";
import { lastmile as L } from "../src/index";
const track = (net: string, width: number, id = net) => `(segment (start 0 0) (end 1 0) (width ${width}) (layer "F.Cu") (net "${net}") (uuid "${id}"))`;
const pcb = (s: string) => copperBoard(`(kicad_pcb ${s})`);
test("removed LED copper and new OUT branch keep pre-edit minimum; new nets have no floor", () => {
  const seed = pcb(track("LED_A", .25) + track("OUT", .25));
  expect(widthFloors(pcb(''), netFacts(seed))).toEqual({ LED_A: .25, OUT: .25 });
  const check = widthCheck(seed, pcb(track("OUT", .2, "branch") + track("NEW", .2)));
  expect(check.rejected.join()).toContain("OUT: 0.2 mm below 0.25 mm");
  expect(widthCheck(seed, pcb(track("OUT", .2)), true).text).toContain("allowed narrowing");
});
test("mixed power widths use narrowest, rules win and pairs keep their dimensions", () => {
  const seed = pcb(track("VBUS", .3) + track("VBUS", .5, "trunk") + track("D_P", .15));
  expect(widthFloors(seed)).toEqual({ VBUS: .3, D_P: .15 });
  const args = krtWidthArgs(["--track-width", "0.2"], { VBUS: .3 }, { VBUS: .6 });
  expect(args).toContain("0.6");
  expect(krtWidthArgs(["--track-width", "0.15", "--diff-pair-gap", "0.2"], {}, {})).toEqual(["--track-width", "0.15", "--diff-pair-gap", "0.2"]);
});
test("revision-bound baseline survives removal and later handoff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "width-baseline-"));
  try {
    const seed = pcb(track("VBUS", .25) + track("VBUS", .4, "trunk"));
    const cut = pcb(track("VBUS", .4, "trunk"));
    await saveWidthBaseline(dir, seed, cut);
    expect(widthFloors(cut, await referenceFacts(dir, cut.revision))).toEqual({ VBUS: .25 });
    expect(await referenceFacts(dir, seed.revision)).toEqual([]);
    await saveWidthBaseline(dir, cut, pcb(''));
    expect(widthFloors(pcb(''), await referenceFacts(dir, pcb('').revision))).toEqual({ VBUS: .25 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("recovered 555 and FFC seed floors", async () => {
  const root = join(import.meta.dir, "fixtures/width-policy");
  const led = pcb('');
  const a = copperBoard(await readFile(join(root, "555-move-led.kicad_pcb"), "utf8"));
  const b = copperBoard(await readFile(join(root, "ffc-rotate.kicad_pcb"), "utf8"));
  expect(widthFloors(led, netFacts(a))["/OUT"]).toBe(.25);
  expect(widthFloors(led, netFacts(a))["/LED_A"]).toBe(.25);
  expect(widthFloors(b)["VBUS_5V"]).toBe(.3);
});

for (const allow of [false, true]) test(`last-mile gate and adoption inspect delivered copper, allow=${allow}`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "width-gate-"));
  try {
    const before = pcb(track("OUT", .25));
    const cut = pcb('');
    await writeFile(join(dir, "board.kicad_pcb"), '(kicad_pcb )');
    await saveWidthBaseline(dir, before, cut);
    if (allow) await allowWidthChange(dir);
    const figures = (open: number): L.Figures => ({ open, drc: {}, a7: 0, a7_mm: 0, a8: 0, pairs_todo: 0, pairs: {} });
    const deps: L.BenchDeps = {
      availableGiB: async () => 20,
      scorer: { async score(d) {
        const text = await readFile(join(d, "board.kicad_pcb"), "utf8");
        return { figures: figures(text.includes("segment") ? 0 : 1), opens: [], summary: {}, parityChecked: true, pairsOverSkewLimit: 0, a8: { toReroute: [], failing: [] } };
      } },
      engine: { async run(_s, i) {
        expect(widthFloors(cut, await referenceFacts(i.cur, cut.revision))).toEqual({ OUT: .25 });
        await mkdir(i.out, { recursive: true });
        await writeFile(join(i.out, i.pcb), `(kicad_pcb ${track("OUT", .2, "new")})`);
        return { dir: i.out };
      } },
    };
    const { bench } = await L.Bench.create(join(dir, ".lastmile"), dir, "board.kicad_pcb", deps);
    const result = await bench.try(["finish"], { noScoped: true, noAvoid: true });
    expect(Boolean(result.accepted)).toBe(allow);
    if (!allow) expect(result.candidates[0]!.rejected.join()).toContain("OUT: 0.2 mm below 0.25 mm");
    else expect(result.lines.join()).toContain("allowed narrowing");
    if (!allow) {
      const adopted = await bench.acceptDir(result.candidates[0]!.dir!);
      expect(adopted.ok).toBe(false);
      expect(adopted.lines.join()).toContain("OUT: 0.2 mm below 0.25 mm");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("native class and custom minimum win without rewriting the source project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "width-rules-"));
  try {
    const pro = JSON.stringify({ net_settings: { classes: [{ name: "Default", track_width: .2 }, { name: "Power", track_width: .5 }], netclass_assignments: { VBUS: "Power" } } });
    await writeFile(join(dir, "board.kicad_pro"), pro);
    await writeFile(join(dir, "board.kicad_dru"), `(version 1) (rule "wide" (condition "A.NetName == 'VBUS'") (constraint track_width (min 0.6mm)))`);
    expect(await classWidthFloors(dir, "board", ["VBUS", "NEW"])).toEqual({ VBUS: .6, NEW: .2 });
    expect(await readFile(join(dir, "board.kicad_pro"), "utf8")).toBe(pro);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("saved move-LED and FFC KRT stages are rejected against recovered seeds", async () => {
  const root = join(import.meta.dir, "fixtures/width-policy");
  for (const name of ["555-move-led", "ffc-rotate"]) {
    const seed = copperBoard(await readFile(join(root, `${name}.kicad_pcb`), "utf8"));
    const delivered = copperBoard(await readFile(join(root, `${name}-old-finish.kicad_pcb`), "utf8"));
    const check = widthCheck(seed, delivered);
    expect(check.rejected.join()).toContain(name === "555-move-led" ? "/OUT: 0.2 mm below 0.25 mm" : "VBUS_5V: 0.2 mm below 0.3 mm");
    if (name === "555-move-led") expect(check.rejected.join()).toContain("/LED_A: 0.2 mm below 0.25 mm");
  }
});

test("route_run quality uses the pre-removal minimum even when only the wide trunk remains", () => {
  const original = pcb(track("VBUS", .3) + track("VBUS", .5, "trunk"));
  const retained = pcb(track("VBUS", .5, "trunk"));
  const repaired = pcb(track("VBUS", .5, "trunk") + track("VBUS", .3, "replacement"));
  const check = compareQuality(quality(retained, ["VBUS"], [], netFacts(original)), quality(repaired, ["VBUS"]), { before: 1, after: 0 }, 0);
  expect(check.warnings).toEqual([]);
  expect(check.text).toContain("kept 0.3 mm");
});

test("KRT first matching selector receives the floor and stronger fnmatch overrides", () => {
  // Expected effective match from Python fnmatch (KRT identify_power_nets).
  for (const [pattern, net, existing] of [["*", "OUT", .2], ["OUT[0-9]", "OUT2", .6], ["OUT[!A-Z]", "OUT2", .7], ["OUT[[]2]", "OUT[2]", .8]] as const) {
    const args = krtWidthArgs(["--power-nets", pattern, "--power-nets-widths", String(existing)], { [net]: .3 }, {});
    const patterns = args.slice(args.indexOf("--power-nets") + 1, args.indexOf("--power-nets-widths"));
    const widths = args.slice(args.indexOf("--power-nets-widths") + 1).map(Number);
    // First selector must be the escaped exact net, ahead of any broad existing selector.
    expect(patterns[0]).toBe(net.replace(/[\[?*]/g, c => c === "[" ? "[[]" : `[${c}]`));
    const matched = patterns.findIndex(p => krtPatternMatches(p, net));
    expect(matched).toBe(0);
    expect(widths[matched]).toBe(Math.max(.3, existing));
  }
});
test("pair native floor keeps pair preference while global/custom minima still apply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pair-floor-"));
  try {
    await writeFile(join(dir, "board.kicad_pcb"), `(kicad_pcb (net "USB_DP") (net "USB_DN") ${track("USB_DP", .2)} ${track("USB_DN", .2)})`);
    await writeFile(join(dir, "board.kicad_pro"), JSON.stringify({ board: { design_settings: { rules: { min_track_width: .1 } } }, net_settings: { classes: [{ name: "USB", track_width: .5, diff_pair_width: .2, diff_pair_gap: .15 }], netclass_patterns: [{ pattern: "USB_D*", netclass: "USB" }] } }));
    expect(await classWidthFloors(dir, "board", ["USB_DP", "USB_DN"])).toEqual({ USB_DP: .2, USB_DN: .2 });
    await writeFile(join(dir, "board.kicad_dru"), `(version 1) (rule "minimum" (condition "A.NetName == 'USB_D*'") (constraint track_width (min 0.3mm)))`);
    expect(await classWidthFloors(dir, "board", ["USB_DP", "USB_DN"])).toEqual({ USB_DP: .3, USB_DN: .3 });
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test("KRT fnmatch selectors support ranges, negation and literal metacharacters", () => {
  for (const [pattern, net, matches] of [
    ["OUT[0-9]", "OUT2", true], ["OUT[!A-Z]", "OUTQ", false],
    ["OUT[!A-Z]", "OUT2", true], ["OUT[[]2]", "OUT[2]", true],
    ["[]]", "]", true], ["[!]]", "A", true], ["[z-a]", "z", false],
    ["[*][?]", "*?", true], ["OUT?", "OUT/", true], ["OUT*", "OUT/branch", true],
    ["[", "[", true], ["*", "OUT\n", true], ["OUT", "OUT\n", false],
  ] as const) expect(krtPatternMatches(pattern, net)).toBe(matches);
  const args = krtWidthArgs(["--power-nets", "*", "--power-nets-widths", "0.2"], {OUT: .3}, {});
  const patterns = args.slice(args.indexOf("--power-nets") + 1, args.indexOf("--power-nets-widths"));
  const widths = args.slice(args.indexOf("--power-nets-widths") + 1).map(Number);
  expect(widths[patterns.findIndex(p => krtPatternMatches(p, "UNRELATED"))]).toBe(.2);
});
