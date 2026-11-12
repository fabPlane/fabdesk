import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembled,
  capValue,
  changePage,
  changeSummary,
  changeSvgStandalone,
  classify,
  diffModels,
  dispose,
  evaluate,
  fixProposals,
  fnmatch,
  findingId,
  impedance,
  importExpert,
  judge,
  loadNetlist,
  modelOf,
  netVolts,
  openReviewProject,
  pinsense,
  reviewGate,
  reviewStatus,
  runReview,
  traceRiseC,
  type CliResult,
  type ReviewEnv,
  type ReviewRecord,
} from "../src/index";
import { applyCards } from "../src/review/rulecards";
import { writeJsonFile } from "../src/files";

const dirs: string[] = [];
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "review-"));
  dirs.push(d);
  return d;
};
beforeAll(() => {
  process.env["FABDESK_FETCH_CACHE"] = join(tmpdir(), "review-test-empty-cache");
});
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const fp = (ref: string, x: number, y: number, pads: Array<[string, string, number, number]>, extra = "", value = "10k") => `
	(footprint "Lib:${ref}"
		(layer "F.Cu")
		(at ${x} ${y})
		(property "Reference" "${ref}" (at 0 0))
		(property "Value" "${value}" (at 0 0))
		${extra}
		${pads.map(([n, net, px, py]) => `(pad "${n}" smd rect (at ${px} ${py}) (size 0.6 0.6) (layers "F.Cu" "F.Paste") (net "${net}"))`).join("\n")}
	)`;

const PCB = `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
	(gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))
	${fp("J1", 2, 15, [["1", "SIG", -1.5, 0], ["2", "SIG2", -1.5, 1]], '(fp_rect (start -3 -4) (end 3 4) (layer "F.CrtYd"))', "USB")}
	${fp("U1", 20, 20, [["1", "VDD", 0, 0], ["2", "GND", 1, 0], ["3", "SIG", 2, 0], ["4", "SIG2", 3, 0]], "", "MCU")}
	${fp("C1", 30, 20, [["1", "VDD", -0.5, 0], ["2", "GND", 0.5, 0]], "", "100n")}
)`;

const comp = (ref: string, value: string, lib: string, part: string, extra = "") => `<comp ref="${ref}"><value>${value}</value><footprint>F:x</footprint><libsource lib="${lib}" part="${part}" description="d"/>${extra}</comp>`;
const node = (ref: string, pin: string, fn: string, type: string) => `<node ref="${ref}" pin="${pin}" pinfunction="${fn}" pintype="${type}"/>`;
const NETLIST = `<?xml version="1.0" encoding="UTF-8"?><export version="E"><components>
${comp("J1", "USB", "Connector", "USB_C")}${comp("U1", "MCU", "MCU", "X")}${comp("C1", "100n", "Device", "C")}
</components><nets>
<net code="1" name="VDD">${node("U1", "1", "VDD", "power_in")}${node("C1", "1", "~", "passive")}</net>
<net code="2" name="GND">${node("U1", "2", "GND", "power_in")}${node("C1", "2", "~", "passive")}</net>
<net code="3" name="SIG">${node("J1", "1", "1", "passive")}${node("U1", "3", "IO1", "bidirectional")}</net>
<net code="4" name="SIG2">${node("U1", "4", "FAULT", "open_collector")}</net>
<net code="5" name="SIG3">${node("J1", "2", "2", "passive")}</net>
</nets></export>`;

async function project(opts: { pcb?: string } = {}) {
  const dir = await tmp();
  await writeFile(join(dir, "board.kicad_pcb"), opts.pcb ?? PCB);
  await writeFile(join(dir, "board.kicad_sch"), "(kicad_sch)");
  return dir;
}

type Fake = { ercViolations?: unknown[]; drcFails?: boolean; touch?: () => Promise<void>; calls: string[][] };
function fakeEnv(f: Fake = { calls: [] }): ReviewEnv {
  return {
    kicadVersion: "fake 1.0",
    kicad: async (args): Promise<CliResult> => {
      f.calls.push(args);
      const o = args.indexOf("-o");
      const out = o >= 0 ? args[o + 1]! : "";
      const sub = args.slice(0, 3).join(" ");
      if (sub.startsWith("sch export netlist")) await writeFile(out, NETLIST);
      else if (sub.startsWith("sch erc")) await writeFile(out, JSON.stringify({ sheets: [{ violations: f.ercViolations ?? [{ type: "pin_not_connected", severity: "error", description: "Pin not connected", items: [{ description: "Pin 3 of U1", pos: { x: 1, y: 2 } }] }] }] }));
      else if (sub.startsWith("pcb drc")) {
        if (!f.drcFails) await writeFile(out, JSON.stringify({ violations: [], unconnected_items: [], schematic_parity: [] }));
      } else if (sub.startsWith("pcb render")) await writeFile(out, "png");
      await f.touch?.();
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  };
}

describe("finding ids and judgement", () => {
  test("ids follow the toolkit's rule", () => {
    expect(findingId({ layer: "L3", rule: "DECAP", ref: "U1", pad: "", key: "" })).toBe("L3:DECAP:U1:-");
    expect(findingId({ layer: "L1", rule: "ERC", ref: "", pad: "", key: "error-pin not/connected" })).toBe("L1:ERC:-:-:error-pin_not_connected");
  });
  test("notes never block; a question needs a reason; fix stays open", () => {
    expect(judge({ severity: "note" }, null)).toEqual([false, "note"]);
    expect(judge({ severity: "question" }, null)).toEqual([true, "no disposition"]);
    expect(judge({ severity: "question" }, { state: "accept", by: "agent", reason: "" })).toEqual([true, "disposition has no reason"]);
    expect(judge({ severity: "question" }, { state: "fix", by: "agent", reason: "r" })[0]).toBe(true);
    expect(judge({ severity: "question" }, { state: "accept", by: "agent", reason: "r" })[0]).toBe(false);
  });
  test("false-positive needs a third source; an agent's must-fix accept needs the owner's leave and evidence", () => {
    expect(judge({ severity: "question" }, { state: "false-positive", by: "agent", reason: "r" })[1]).toBe("false-positive needs a third source");
    const d = { state: "accept" as const, by: "agent", reason: "r", third_source: "datasheet p4" };
    expect(judge({ severity: "must-fix" }, d)[1]).toContain("asks to be asked");
    expect(judge({ severity: "must-fix" }, d, { preferences: { ask_owner_for: [] } })[0]).toBe(false);
    expect(judge({ severity: "must-fix" }, { ...d, third_source: "" }, { preferences: { ask_owner_for: [] } })[1]).toContain("needs evidence");
    expect(judge({ severity: "must-fix" }, { ...d, by: "owner" })[0]).toBe(false);
  });
  test("fnmatch matches whole names", () => {
    expect(fnmatch("L2:O:C18_U1:3", "L2:O:C18_U1:*")).toBe(true);
    expect(fnmatch("L2:O:C18_U1:3", "L2:O:C18_U?:3")).toBe(true);
    expect(fnmatch("L2:O:C18_U1:3", "L2:O:C18")).toBe(false);
  });
});

describe("netlist and pin semantics", () => {
  test("the XML netlist reads parts, pins in netlist order and generic names", () => {
    const comps = loadNetlist(NETLIST);
    expect([...comps.keys()]).toEqual(["J1", "U1", "C1"]);
    const j1 = comps.get("J1")!;
    expect(j1.pins.get("1")).toEqual({ name: "1", type: "passive", net: "SIG", nodes: 2 });
    expect([...comps.get("U1")!.pins.keys()]).toEqual(["1", "2", "3", "4"]);
  });
  test("a silent FAULT output (F) and a supply pin on ground (R) are found; a generic symbol (G) on an active part too", async () => {
    const xml = `<export><components>${comp("U7", "X", "Conn", "Y")}${comp("U1", "MCU", "MCU", "X")}</components><nets>
<net code="1" name="GND">${node("U1", "1", "VDD", "power_in")}${node("U1", "2", "GND", "power_in")}${node("U1", "3", "IO", "bidirectional")}</net>
<net code="2" name="N1">${node("U7", "1", "1", "passive")}${node("U7", "2", "2", "passive")}${node("U7", "3", "3", "passive")}</net>
<net code="3" name="X">${node("U1", "4", "FAULT", "open_collector")}</net></nets></export>`;
    const res = await pinsense.review(loadNetlist(xml), null);
    const by = Object.fromEntries(res.raw.map((x) => [`${x.rule}:${x.ref}:${x.pin}`, x.severity]));
    expect(by["G:U7:*"]).toBe("warning");
    expect(by["F:U1:4"]).toBe("warning");
    expect(by["R:U1:1"]).toBe("error");
  });
  test("pin name comparison", () => {
    expect(pinsense.same("DP", "D+")).toBe(true);
    expect(pinsense.same("GND", "VSS")).toBe(true);
    expect(pinsense.same("SDA", "SCL")).toBe(false);
    expect(pinsense.numeric("Pin_3")).toBe(true);
    expect(pinsense.isGndNet("a74::PGND")).toBe(true);
  });
  test("rule cards walk from a pin through two-terminal parts (a datasheet card checked against the PDF raises must-fix)", async () => {
    const xml = `<export><components>${comp("U1", "TPS62822", "P", "Q")}${comp("R1", "10k", "D", "R")}${comp("C5", "100n", "D", "C")}</components><nets>
<net code="1" name="FBN">${node("U1", "1", "FB", "input")}${node("R1", "1", "~", "passive")}</net>
<net code="2" name="VOUT">${node("R1", "2", "~", "passive")}</net>
<net code="3" name="SW">${node("U1", "2", "SW", "output")}</net>
<net code="4" name="GND">${node("U1", "3", "GND", "power_in")}${node("C5", "1", "~", "passive")}</net></nets></export>`;
    const card = { match: "TPS62822", source_kind: "datasheet", checked_against_datasheet: true, rules: [{ pin: "FB", path: ["R"], arrives_pin: "SW", why: "divider" }], _file: "t.json" };
    const r = await applyCards(loadNetlist(xml), [card], null);
    expect(r.evaluated).toBe(1);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.severity).toBe("must-fix");
    const q = await applyCards(loadNetlist(xml), [{ ...card, checked_against_datasheet: false }], null);
    expect(q.findings[0]!.severity).toBe("question");
  });
});

describe("closed-form figures", () => {
  test("stack-up parsing and a microstrip pair land where the toolkit's formula puts them", () => {
    const text = `(setup (stackup (layer "F.Cu" (type "copper") (thickness 0.035))
(layer "dielectric 1" (type "core") (thickness 0.2) (material "FR4") (epsilon_r 4.5))
(layer "B.Cu" (type "copper") (thickness 0.035))))`;
    const st = impedance.stackup(text);
    expect(st.map((s) => s.name)).toEqual(["F.Cu", "dielectric 1", "B.Cu"]);
    const geo = impedance.reference(st, "F.Cu", new Set(["B.Cu"]))!;
    expect(geo.kind).toBe("microstrip");
    // 87/sqrt(4.5+1.41) * ln(5.98*0.2/(0.8*0.2+0.035)), then the coupling factor
    const z = impedance.zdiff(0.2, 0.2, geo);
    expect(z).toBeGreaterThan(70);
    expect(z).toBeLessThan(110);
    expect(Math.round(impedance.zdiff(0.2, 0.2, geo) * 10)).toBe(Math.round(2 * ((87 / Math.sqrt(5.91)) * Math.log((5.98 * 0.2) / (0.8 * 0.2 + 0.035))) * (1 - 0.48 * Math.exp((-0.96 * 0.2) / 0.2)) * 10));
  });
  test("target comes from the class text, the name, then the interface profiles", () => {
    const profs = { usb2: { match: "USB2", zdiff: 90, tol_pct: 15 } };
    expect(impedance.targetOf("USB2_HS", {}, profs)).toEqual([90, 15, "usb2"]);
    expect(impedance.targetOf("PAIR_100R", { target: "85 ohm +/-10 %" }, profs)).toEqual([85, 10, null]);
  });
  test("trace heating inverts the IPC-2152 fit; voltages, values and capacitor ratings parse", () => {
    expect(traceRiseC(1, 0.2, 0.035)).toBeGreaterThan(traceRiseC(1, 0.4, 0.035));
    expect(netVolts("+3V3", {})).toBe(3.3);
    expect(netVolts("GND", {})).toBe(0);
    expect(netVolts("VBUS", {})).toBeNull();
    expect(netVolts("RAIL_A", { "^RAIL_": 12 })).toBe(12);
    expect(capValue("100n")).toBeCloseTo(1e-7);
    expect(capValue("10uF")).toBeCloseTo(1e-5);
    expect(assembled({ ref: "H1", flags: [], pads: [{ net: "" }] })).toBe(false);
    expect(assembled({ ref: "R1", flags: ["dnp"], pads: [{ net: "A" }] })).toBe(false);
  });
});

describe("a review run, the gate and dispositions", () => {
  test("every check runs; findings carry proposals; the gate leads with them", async () => {
    const dir = await project();
    const project_ = await openReviewProject(dir);
    expect((await reviewGate(project_)).exit).toBe(1);
    const r = await runReview(project_, fakeEnv(), { offline: true });
    const names = r.review.checks.map((c) => c.name);
    expect(names).toEqual(["identity", "netlist", "erc", "drc", "acceptance", "pinsense", "cards", "decoupling", "current", "impedance", "manual", "mouth", "interconnect", "bom", "ratings", "coverage", "evidence", "custom", "pack"]);
    const by = (rule: string) => r.review.findings.filter((f) => f.rule === rule);
    expect(by("MOUTH")[0]!.severity).toBe("must-fix");
    expect(by("MOUTH")[0]!.ref).toBe("J1");
    expect(by("DECAP")[0]!.ref).toBe("U1");
    expect(by("DECAP")[0]!.evidence[0]!.data).toMatchObject({ cap: "C1", pin: "1" });
    expect(by("ERC")[0]!.severity).toBe("must-fix");
    expect(by("F")[0]!.pad).toBe("4"); // the FAULT output nobody reads
    expect(r.review.findings.every((f) => f.severity === "note" || f.proposal)).toBe(true);
    const g = await reviewGate(project_);
    expect(g.exit).toBe(2);
    expect(g.lines[0]).toMatch(/^REVIEW GATE: \d+ open/);
    expect(g.lines.some((l) => l.includes("NEEDS OWNER") || l.startsWith("- auto") || l.startsWith("- task"))).toBe(true);
    // the report is a page: verdict, checks table, to-settle list with the proposal under each rule once
    const md = await readFile(join(r.dir, "review.md"), "utf8");
    expect(md).toContain("# Review");
    expect(md).toContain("**proposed (");
  });

  test("dispose settles by id and wildcard; stale design blocks; an edit makes the review stale", async () => {
    const dir = await project();
    const p = await openReviewProject(dir);
    await runReview(p, fakeEnv(), { offline: true });
    await expect(dispose(p, { id: "nope", state: "accept", by: "agent", reason: "r" })).rejects.toThrow("no finding");
    await expect(dispose(p, { id: "L3:DECAP:U1:-", state: "maybe", by: "agent", reason: "r" })).rejects.toThrow("state must be one of");
    const open = (await reviewStatus(p)).open;
    expect(open).toBeGreaterThan(3);
    const d = await dispose(p, { id: "L*", state: "accept", by: "owner", reason: "reviewed on the bench", third_source: "bench log" });
    expect(d.disposed.length).toBeGreaterThan(3);
    await dispose(p, { id: "L8:EXPERT:-:-:pending", state: "accept", by: "owner", reason: "owner declines a second reviewer" });
    const g = await reviewGate(p);
    expect(g.exit).toBe(0);
    expect(g.state).toBe("pass");
    // disposition carries by id into the next run and is marked carried
    await writeFile(join(dir, "board.kicad_pcb"), PCB + "\n");
    expect((await reviewGate(p)).exit).toBe(1);
    expect((await reviewGate(p)).lines[0]).toContain("stale");
    const r2 = await runReview(p, fakeEnv(), { offline: true });
    const carried = r2.evaluation.rows.filter((x) => x.carried);
    expect(carried.length).toBeGreaterThan(3);
    expect((await reviewGate(p)).exit).toBe(0);
  });

  test("a check that cannot run is an error and the gate never passes it", async () => {
    const dir = await project();
    const p = await openReviewProject(dir);
    await runReview(p, fakeEnv({ drcFails: true, calls: [] }), { offline: true });
    await dispose(p, { id: "*", state: "accept", by: "owner", reason: "r", third_source: "s" });
    const g = await reviewGate(p);
    expect(g.exit).toBe(3);
    expect(g.errors).toBe(true);
  });

  test("a design that changes during the run is an error", async () => {
    const dir = await project();
    const p = await openReviewProject(dir);
    let done = false;
    const env = fakeEnv({
      calls: [],
      touch: async () => {
        if (!done) {
          done = true;
          await writeFile(join(dir, "board.kicad_pcb"), PCB + "\n");
        }
      },
    });
    const r = await runReview(p, env, { offline: true });
    expect(r.review.checks.find((c) => c.name === "hash-stable")?.status).toBe("error");
  });

  test("an owner decision in the intent file settles what it covers, cited, in every later run", async () => {
    const dir = await project();
    await writeJsonFile(join(dir, ".fabdesk", "board", "review", "intent.json"), { decisions: [{ id: "D1", decision: "the USB-C faces in on purpose", date: "2026-11-12", covers: [{ rule: "MOUTH", refs: ["J1"] }] }] });
    const p = await openReviewProject(dir);
    const r = await runReview(p, fakeEnv(), { offline: true });
    const row = r.evaluation.rows.find((x) => x.rule === "MOUTH")!;
    expect(row.open).toBe(false);
    expect(row.disposition?.reason).toContain("intent decision D1");
    expect(row.proposal?.apply.kind).toBe("disposition");
  });

  test("partial runs are not the project's review", async () => {
    const dir = await project();
    const p = await openReviewProject(dir);
    await runReview(p, fakeEnv(), { checks: ["identity", "netlist", "mouth"], offline: true });
    expect((await reviewGate(p)).exit).toBe(1);
  });

  test("custom checks are data, run only when trusted, and a bad output is an error", async () => {
    const dir = await project();
    const cd = join(dir, ".fabdesk", "board", "review", "checks.d");
    await mkdir(cd, { recursive: true });
    await writeFile(join(cd, "mine.json"), JSON.stringify({ name: "mine", layer: "L3", run: `echo '[{"rule":"X","severity":"must-fix","claim":"nope","ref":"U1"}]'` }));
    const p = await openReviewProject(dir);
    const off = await runReview(p, fakeEnv(), { checks: ["custom"], offline: true });
    expect(off.review.checks[0]!.status).toBe("skipped");
    expect(off.review.findings).toHaveLength(0);
    const on = await runReview(p, { ...fakeEnv(), trustCustom: true }, { checks: ["custom"], offline: true });
    expect(on.review.findings.map((f) => f.id)).toEqual(["L3:X:U1:-"]);
    await writeFile(join(cd, "mine.json"), JSON.stringify({ name: "mine", run: "echo not-json" }));
    const bad = await runReview(p, { ...fakeEnv(), trustCustom: true }, { checks: ["custom"], offline: true });
    expect(bad.review.checks[0]!.status).toBe("error");
  });

  test("import_expert replaces the pending marker; a PROBLEM without evidence is a question", async () => {
    const dir = await project();
    const p = await openReviewProject(dir);
    await runReview(p, fakeEnv(), { offline: true });
    const r = await importExpert(p, { reviewer: "fresh", findings: [{ severity: "PROBLEM", ref: "U1", claim: "no reset pull-up", evidence: "" }, { severity: "PROBLEM", ref: "J1", claim: "wrong keying", evidence: "datasheet 4.2" }, { severity: "NOTE", claim: "fine" }] });
    expect(r.imported).toBe(3);
    const cur = JSON.parse(await readFile(join(r.run, "review.json"), "utf8")) as ReviewRecord;
    const ex = cur.findings.filter((f) => f.check === "expert");
    expect(ex.map((f) => f.severity)).toEqual(["question", "must-fix", "note"]);
    expect(cur.findings.some((f) => f.id === "L8:EXPERT:-:-:pending")).toBe(false);
    expect(cur.checks.find((c) => c.name === "expert")?.detail).toBe("3 findings from fresh");
  });

  test("fix lists the proposals, settles the workflow's dispositions on apply and hands edit plans over unbuilt", async () => {
    const dir = await project();
    await writeJsonFile(join(dir, ".fabdesk", "board", "review", "intent.json"), { decisions: [] });
    // requirements make the board a flow board: the decoupling proposal becomes an edit plan
    await mkdir(join(dir, ".fabdesk", "board", "requirements"), { recursive: true });
    const p = await openReviewProject(dir);
    const r = await runReview(p, fakeEnv(), { offline: true });
    const plain = await fixProposals(p);
    expect(plain.open).toBe(r.evaluation.open.length);
    expect(plain.settled).toEqual([]);
    expect(plain.lines.some((l) => l.includes("NEEDS OWNER"))).toBe(true);
    const applied = await fixProposals(p, { apply: true });
    expect(applied.tasks.length + applied.commands.length + applied.edits.length + applied.settled.length).toBe(applied.workflow.length);
    const k = await classify(p, (await reviewGate(p)).exit === 2 ? evaluate(r.review, {}).open : []);
    expect(k.owner.length + k.auto.length + k.task.length + k.candidate.length).toBe(evaluate(r.review, {}).open.length);
  });
});

describe("the change picture", () => {
  const board = (x: number) => `(kicad_pcb (version 20250114) (gr_rect (start 0 0) (end 20 20) (layer "Edge.Cuts"))
	${fp("C1", x, 5, [["1", "A", 0, 0], ["2", "B", 1, 0]])}
	(segment (start 1 1) (end 9 1) (width 0.2) (layer "F.Cu") (net "A"))
	${x > 5 ? '(segment (start 1 2) (end 9 2) (width 0.2) (layer "F.Cu") (net "A"))\n	(via (at 3 3) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "A"))' : ""}
)`;
  test("moved parts, added copper and the counts", () => {
    const d = diffModels(modelOf(board(5)), modelOf(board(10)));
    expect(d.moved.map((m) => [m.ref, m.mm])).toEqual([["C1", 5]]);
    expect(d.seg_add).toHaveLength(1);
    expect(d.seg_same).toHaveLength(1);
    expect(d.via_add).toHaveLength(1);
    expect(changeSummary(d)).toBe("tracks +1/-0, vias +1/-0, parts moved 1, added 0, removed 0");
    const page = changePage(d);
    expect(page).toContain("<svg");
    expect(page).toContain("Board change");
    expect(changeSvgStandalone(d)).toContain("<style>");
    expect(changeSvgStandalone(d)).not.toContain("var(--");
  });
});
