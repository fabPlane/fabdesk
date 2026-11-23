import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { parseSexpr, release, topLevelSpans } from "../src";
import { removeBlocks } from "../src/edit/text";

const gerber = `%TF.FileFunction,Copper,L1,Top*%
%FSLAX46Y46*%
%MOMM*%
%AMRoundRect*
4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*
1,1,$1+$1,$2,$3*
1,1,$1+$1,$4,$5*
1,1,$1+$1,$6,$7*
1,1,$1+$1,$8,$9*
20,1,$1+$1,$2,$3,$4,$5,0*
20,1,$1+$1,$4,$5,$6,$7,0*
20,1,$1+$1,$6,$7,$8,$9,0*
20,1,$1+$1,$8,$9,$2,$3,0*%
%TA.AperFunction,SMDPad,CuDef*%
%ADD10R,1.000000X2.000000*%
%ADD11RoundRect,0.100000X-0.500000X-0.300000X0.500000X-0.300000X0.500000X0.300000X-0.500000X0.300000X0*%
%TD*%
%ADD12C,0.200000*%
%LPD*%
G01*
%TO.P,R1,1*%
D10*
X10000000Y-20000000D03*
%TO.P,R1,2*%
D11*
X14000000Y-20000000D03*
%TD*%
D12*
X0Y0D02*
X5000000Y0D01*
G75*
G03*
X5000000Y5000000I0J2500000D01*
%TO.P,U1,A1*%
G36*
X20000000Y-10000000D02*
X22000000Y-10000000D01*
X22000000Y-12000000D01*
X20000000Y-12000000D01*
G37*
%TD*%
M02*
`;

describe("gerber reader", () => {
  const g = release.parseGerber(gerber);
  test("apertures, flashes, draws, arcs and regions with their object attributes", () => {
    expect(g.apertures.size).toBe(3);
    expect(g.apertures.get(10)!.kind).toBe("R");
    expect(g.apertures.get(11)!.macro).toBe("RoundRect");
    expect(g.apertures.get(11)!.fn).toBe("SMDPad,CuDef");
    expect(g.fileFunction).toBe("Copper,L1,Top");
    const kinds = g.objects.map((o) => o.kind);
    expect(kinds.filter((k) => k === "flash")).toHaveLength(2);
    expect(kinds.filter((k) => k === "draw")).toHaveLength(2);
    expect(kinds.filter((k) => k === "region")).toHaveLength(1);
  });
  test("pad positions by X2 attribute: flashes and the centre of regions", () => {
    const p = release.gerberPads(g);
    expect(p.get("R1\u00001")).toEqual([[10, -20]]);
    expect(p.get("R1\u00002")).toEqual([[14, -20]]);
    expect(p.get("U1\u0000A1")).toEqual([[21, -11]]);
  });
  test("the macro aperture becomes the rounded rectangle's primitives", () => {
    const prims = release.aperturePrims(g.apertures.get(11)!, g.macros, 1);
    expect(prims.filter((q) => q.t === "circle")).toHaveLength(4);
    expect(prims.filter((q) => q.t === "poly")).toHaveLength(5);
  });
  test("SVG in board coordinates: Y flipped, one use per flash", () => {
    const svg = release.gerberToSvg(g, { x0: 0, y0: -30, x1: 30, y1: 0 });
    expect(svg).toContain('viewBox="0 -30 30 30"');
    expect(svg).toContain('transform="scale(1,-1)"');
    expect(svg.match(/<use /g)).toHaveLength(2);
  });
  test("Excellon: holes per tool, slots counted once", () => {
    const x = release.parseExcellon("M48\nMETRIC\nT1C0.300\nT2C0.800\n%\nT1\nX1.0Y-1.0\nX2.0Y-1.0\nT2\nX3.0Y-3.0G85X4.0Y-3.0\nM30\n");
    expect(x.tools).toEqual({ "1": 0.3, "2": 0.8 });
    expect(x.holes).toBe(2);
    expect(x.slots).toBe(1);
  });
});

describe("footprint fit", () => {
  const ours = [{ n: "1", x: -0.5, y: 0 }, { n: "2", x: 0.5, y: 0 }];
  test("same footprint: rotation 0, no residual", () => {
    const a = release.align(ours, ours)!;
    expect(a.rotation).toBe(0);
    expect(a.rms_mm).toBe(0);
  });
  test("JLC draws it turned by 90: the rotation that puts our pads on theirs", () => {
    const theirs = [{ n: "1", x: 0, y: -0.5 }, { n: "2", x: 0, y: 0.5 }];
    const a = release.align(ours, theirs)!;
    expect([90, 270]).toContain(a.rotation);
    expect(a.rms_mm).toBe(0);
    expect(a.unmatched_kicad).toEqual([]);
  });
  test("a polarized part whose JLC numbers mean the opposite pins is renumbered by pin function", () => {
    const r = release.polarRenumber([{ n: "1", x: 0, y: 0 }, { n: "2", x: 1, y: 0 }], { "1": "A", "2": "K" }, { "1": "K", "2": "A" });
    expect(r.renumbered).toBe(true);
    expect(r.pads.map((q) => q.n)).toEqual(["2", "1"]);
    expect(release.polarRenumber([{ n: "1", x: 0, y: 0 }, { n: "2", x: 1, y: 0 }], { "1": "A", "2": "K" }, { "1": "A", "2": "K" }).renumbered).toBe(false);
  });
  test("numbering that differs (two-row connector): fit by position, pin 1 onto pin 1", () => {
    const k = [{ n: "1", x: 0, y: 0 }, { n: "2", x: 0, y: 1 }, { n: "3", x: 1, y: 0 }, { n: "4", x: 1, y: 1 }];
    const j = [{ n: "1", x: 0, y: 0 }, { n: "2", x: 1, y: 0 }, { n: "3", x: 0, y: 1 }, { n: "4", x: 1, y: 1 }];
    const a = release.alignGeometry(k, j)!;
    expect(a.fit).toBe("geometry");
    expect(a.rms_mm).toBeLessThan(0.1);
    expect(a.pin1_to_pin1).toBe(true);
  });
});

const board = (extra = "") => `(kicad_pcb (version 20260206) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal))
  (footprint "R_0402" (layer "F.Cu") (at 10 10 90)
    (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))
    (property "Value" "10k" (at 0 0 0) (layer "F.Fab"))
    (property "LCSC" "C25744" (at 0 0 0) (layer "F.Fab"))
    (pad "1" smd roundrect (at -0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "A"))
    (pad "2" smd roundrect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "B")))
  (footprint "R_0402" (layer "B.Cu") (at 20 10 0)
    (property "Reference" "R2" (at 0 0 0) (layer "B.SilkS"))
    (property "Value" "10k" (at 0 0 0) (layer "B.Fab"))
    (property "LCSC" "C99999" (at 0 0 0) (layer "B.Fab"))
    (pad "1" smd roundrect (at -0.5 0) (size 0.5 0.6) (layers "B.Cu") (net 1 "A"))
    (pad "2" smd roundrect (at 0.5 0) (size 0.5 0.6) (layers "B.Cu") (net 2 "B")))
  (footprint "TestPoint" (layer "F.Cu") (at 30 10 0)
    (property "Reference" "TP1" (at 0 0 0) (layer "F.SilkS"))
    (property "Value" "TP" (at 0 0 0) (layer "F.Fab"))
    (pad "1" smd circle (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "A")))
  (footprint "R_0402" (layer "F.Cu") (at 40 10 0)
    (property "Reference" "R9" (at 0 0 0) (layer "F.SilkS"))
    (property "Value" "DNP" (at 0 0 0) (layer "F.Fab"))
    (attr smd dnp)
    (pad "1" smd roundrect (at -0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "A")))
  ${extra}
)`;

const eda = (title: string, pads: Array<[number, number, string]>) => ({
  result: { packageDetail: { title, dataStr: { head: { x: 0, y: 0 }, shape: pads.map(([x, y, n]) => `PAD~RECT~${x}~${y}~2~2.4~1~~${n}~0`) } }, dataStr: { shape: [] } },
});

const lcsc = (model: string) => ({ result: { productModel: model, brandNameEn: "UNI-ROYAL", encapStandard: "0402", productCycle: "normal", smtLabel: "BASE", stockNumber: 90000, productDescEn: "10k 1%" } });
const jlc = (code: string) => ({ data: { componentPageInfo: { list: [{ componentCode: code, stockCount: 80000, componentLibraryType: "base" }] } } });

function transport(calls: string[]) {
  return async (url: string, data: unknown) => {
    calls.push(url + (data ? ` ${JSON.stringify(data)}` : ""));
    if (url.includes("productCode=C25744")) return lcsc("0402WGF1002TCE");
    if (url.includes("productCode=C99999")) return lcsc("0402WGF1002TCE");
    if (url.includes("jlcpcb")) return jlc((data as { keyword: string }).keyword);
    // R1's JLC footprint matches ours; R2's pads run along y (JLC draws it turned)
    if (url.includes("C25744")) return eda("R0402", [[-2, 0, "1"], [2, 0, "2"]]);
    if (url.includes("C99999")) return eda("R0402-turned", [[0, -2, "1"], [0, 2, "2"]]);
    throw new Error(`unexpected ${url}`);
  };
}

describe("bomCheck", () => {
  test("identity from the footprint, stock, JLC footprint fit, CPL rotation, DNP and copper-only handled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bom-"));
    await writeFile(join(dir, "b.kicad_pcb"), board());
    const calls: string[] = [];
    const out = join(dir, "out");
    const r = await release.bomCheck({ project: dir, stem: "b", out, fetch: { transport: transport(calls), shared: null, paceMs: 0 } });
    expect(r.placements).toBe(3); // R1, R2, TP1 (R9 is DNP)
    expect(r.lines).toBe(3);
    const byLine = Object.fromEntries(r.records.map((x) => [x.line, x]));
    expect(byLine["C25744"]!.status).toBe("RESOLVED");
    expect(byLine["C25744"]!.checks["footprint"].rotation).toBe(0);
    expect(byLine["C99999"]!.checks["footprint"].rotation).not.toBe(0);
    expect(byLine["VAL:TP|TestPoint"]!.copper_only).toBe(true);
    const rows = Object.fromEntries(r.cplRows.map((x) => [x.ref, x]));
    expect(rows["R1"]!.jlc_rot).toBe(90); // top: KiCad angle minus the JLC offset (0)
    // bottom part: JLC sees it from below: 180 - angle - offset
    expect(rows["R2"]!.jlc_rot).toBe((((180 - 0 - rows["R2"]!.jlc_offset) % 360) + 360) % 360);
    expect(r.rotation_offsets).toBe(1);
    expect(r.bottom_side_placements).toBe(1);
    for (const f of ["bom-decisions.json", "bom-decisions.csv", "swap-fields.json", "cpl-jlc.csv"]) expect((await stat(join(out, f))).isFile()).toBe(true);
    // every raw response is kept with its URL: the evidence link
    const cached = JSON.parse(await readFile(join(out, "cache", "lcsc-C25744.json"), "utf8"));
    expect(cached.url).toContain("productCode=C25744");
    // a second run reads the evidence cache: no new lookups
    const before = calls.length;
    await release.bomCheck({ project: dir, stem: "b", out, fetch: { transport: transport(calls), shared: null, paceMs: 0 } });
    expect(calls.length).toBe(before);
  });

  test("a line without identity is UNRESOLVED, and PROPOSED when a sibling with the same value and package resolved", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bom-"));
    const extra = `(footprint "R_0402" (layer "F.Cu") (at 50 10 0)
      (property "Reference" "R5" (at 0 0 0) (layer "F.SilkS"))
      (property "Value" "10k" (at 0 0 0) (layer "F.Fab"))
      (pad "1" smd roundrect (at -0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 1 "A"))
      (pad "2" smd roundrect (at 0.5 0) (size 0.5 0.6) (layers "F.Cu") (net 2 "B")))`;
    await writeFile(join(dir, "b.kicad_pcb"), board(extra));
    const r = await release.bomCheck({ project: dir, stem: "b", out: join(dir, "out"), fetch: { transport: transport([]), shared: null, paceMs: 0 } });
    const rec = r.records.find((x) => x.refs.includes("R5"))!;
    expect(rec.status).toBe("PROPOSED");
    expect(rec.proposal!.like).toBe("R1");
    const swaps = JSON.parse(await readFile(join(dir, "out", "swap-fields.json"), "utf8")).swap;
    expect(swaps).toContainEqual({ ref: "R5", fields: { LCSC: "C25744", MPN: "0402WGF1002TCE" } });
  });

  test("an agent override is PROPOSED until written into the schematic; a failed lookup is retried, not trusted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bom-"));
    await writeFile(join(dir, "b.kicad_pcb"), board());
    let fail = true;
    const t = transport([]);
    const flaky = async (url: string, data: unknown) => {
      if (fail && url.includes("productCode=C25744")) throw new Error("HTTP Error 500");
      return t(url, data);
    };
    const first = await release.bomCheck({ project: dir, stem: "b", out: join(dir, "out"), fetch: { transport: flaky, shared: null, paceMs: 0 } });
    expect(first.records.find((x) => x.line === "C25744")!.risks).toContain("LCSC detail unavailable");
    fail = false;
    const second = await release.bomCheck({ project: dir, stem: "b", out: join(dir, "out"), fetch: { transport: flaky, shared: null, paceMs: 0 } });
    expect(second.records.find((x) => x.line === "C25744")!.status).toBe("RESOLVED");
  });

  test("offline with no cache resolves identities from the footprints and predicts nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bom-"));
    await writeFile(join(dir, "b.kicad_pcb"), board());
    const r = await release.bomCheck({ project: dir, stem: "b", out: join(dir, "out"), offline: true });
    expect(r.cplRows).toHaveLength(0);
    expect(r.fetch_calls).toBe(0);
    expect(r.records.find((x) => x.line === "C25744")!.risks.join()).toContain("LCSC detail unavailable");
  });
});

describe("fetch cache", () => {
  test("a shared record younger than the limit is copied in with its evidence; failures are never shared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fx-"));
    let n = 0;
    const a = new release.Fetch(join(dir, "a"), { shared: join(dir, "shared"), paceMs: 0, transport: async () => (n++, { ok: 1 }) });
    await a.get("k", "https://example/x");
    const b = new release.Fetch(join(dir, "b"), { shared: join(dir, "shared"), paceMs: 0, transport: async () => (n++, { ok: 2 }) });
    const rec = await b.get("k", "https://example/x");
    expect(n).toBe(1);
    expect(b.reused).toBe(1);
    expect((rec!.body as { ok: number }).ok).toBe(1);
    const c = new release.Fetch(join(dir, "c"), { shared: join(dir, "shared"), paceMs: 0, transport: async () => { throw new Error("down"); } });
    const bad = await c.get("bad", "https://example/y");
    expect((bad!.body as { _error: string })._error).toBe("down");
    expect(await readdir(join(dir, "shared"))).toEqual(["k.json"]);
  });
});

describe("jlcsim", () => {
  const edaRec = (pads: Array<[number, number, string]>) => ({ url: "u", post: null, fetched: "t", body: eda("T", pads) });
  const top = new Map<string, Array<[number, number]>>([["R1\u00001", [[10, -10.5]]], ["R1\u00002", [[10, -9.5]]]]);
  test("rotation JLC needs puts its footprint on our lands; a CPL with the wrong rotation fails and is solved", () => {
    // our copper: pads stacked in y around (10,-10); JLC footprint pads along x: JLC needs it turned by 90 from its own frame
    const jlcPads: Array<[number, number, string]> = [[-2, 0, "1"], [2, 0, "2"]];
    const input = { top, bottom: new Map(), codes: { R1: "C1" }, eda: () => edaRec(jlcPads) };
    const rows = (rot: string) => [{ Designator: "R1", "Mid X": "10", "Mid Y": "-10", Layer: "Top", Rotation: rot }];
    const good = release.simulatePlacement({ ...input, cpl: rows("90") });
    const bad = release.simulatePlacement({ ...input, cpl: rows("0") });
    expect(good.parts[0]!.verdict).toBe("PASS");
    expect(bad.parts[0]!.verdict).toBe("FAIL");
    expect(bad.parts[0]!.solved!.rot).toBe(90);
    expect(bad.parts[0]!.solved!.verdict).toBe("PASS");
    expect(bad.solved_rows[0]!.Rotation).toBe("90");
    expect(good.solved_rows[0]!.Rotation).toBe("90");
  });
  test("no JLC footprint is NO DATA, a proxy stands in, and a part without pads in copper is NO DATA", () => {
    const base = { top, bottom: new Map(), eda: () => null, cpl: [{ Designator: "R1", "Mid X": "10", "Mid Y": "-10", Layer: "Top", Rotation: "0" }] };
    expect(release.simulatePlacement({ ...base, codes: { R1: "C1" } }).summary.no_jlc_footprint).toEqual(["R1"]);
    const px = release.simulatePlacement({ ...base, codes: { R1: "C1" }, proxies: { C1: { proxy: "C2" } }, eda: (c) => (c === "C2" ? edaRec([[0, -0.5, "1"], [0, 0.5, "2"]]) : null) });
    expect(px.summary.checked_with_proxy_footprint).toEqual(["R1"]);
    expect(release.simulatePlacement({ ...base, top: new Map(), codes: { R1: "C1" } }).parts[0]!.why).toBe("no pads in copper");
  });
  test("names that mean the same pin on both sides match (USB DP/DN, mechanical tabs)", () => {
    expect(release.nname("D+")).toBe("DP");
    expect(release.nname("~{RESET}")).toBe("RESET");
    expect(release.nname("SHIELD")).toBe("MECH");
  });
});

describe("via bindings", () => {
  const withVias = board(`(via (at 10 10.5) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "A") (uuid "v1"))
  (via (at 25 25) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "A") (uuid "v2"))
  (via micro (at 26 26) (size 0.3) (drill 0.1) (layers "F.Cu" "In1.Cu") (net "A") (uuid "v3"))`);
  test("a via whose hole meets SMD pad copper, and every microvia, needs fill and cap", () => {
    // R1 is turned 90: its pad 1 sits at (10, 10.5); a via drilled there is in the pad
    const vs = release.classifyVias(withVias);
    expect(vs).toHaveLength(3);
    const byId = Object.fromEntries(vs.map((v) => [v.uuid, v]));
    expect(byId["v1"]!.in_component_lands).toEqual(["R1.1"]);
    expect(byId["v1"]!.required_filling).toBe(true);
    expect(byId["v2"]!.required_filling).toBe(false);
    expect(byId["v3"]!.type).toBe("micro");
    expect(byId["v3"]!.required_filling).toBe(true);
    const { record, missing } = release.viaBindings("b.kicad_pcb", vs);
    expect(record.counts.micro).toBe(1);
    expect(missing.map((v) => v.uuid).sort()).toEqual(["v1", "v3"]);
    const applied = release.applyViaBindings(withVias, missing);
    const after = release.viaBindings("b.kicad_pcb", release.classifyVias(applied));
    expect(after.missing).toHaveLength(0);
    expect(after.record.counts.filled_not_required).toBe(0);
    // geometry-only change: nothing but the two attributes on the vias that needed them
    expect(applied.replace(/\s*\((capping|filling) yes\)/g, "")).toBe(withVias);
  });
  test("a CRLF board (KiCad block layout, `(via\\r\\n`) is classified like its LF twin", () => {
    const lf = withVias.replace(/\(via( micro)? /g, (_m, k: string | undefined) => `(via${k ?? ""}\n\t\t`);
    const crlf = lf.replace(/\r?\n/g, "\r\n");
    const a = release.classifyVias(lf);
    const b = release.classifyVias(crlf);
    expect(a).toHaveLength(3);
    expect(b.map(({ span_: _s, ...v }) => v)).toEqual(a.map(({ span_: _s, ...v }) => v));
    const vip = release.viaBindings("b.kicad_pcb", b).record.counts;
    expect(vip.via_in_pad).toBe(1);
    expect(vip.require_fill_cap).toBe(2);
    const applied = release.applyViaBindings(crlf, release.viaBindings("b.kicad_pcb", b).missing);
    expect(applied.replace(/\r\n/g, "")).not.toContain("\n"); // stays CRLF
    expect(release.viaBindings("b.kicad_pcb", release.classifyVias(applied)).missing).toHaveLength(0);
  });
  test("pad shapes: rect, circle and oval hole tests", () => {
    const pad = { x: 0, y: 0, ang: 0, w: 1, h: 0.5 };
    expect(release.holeMeetsPad(0.7, 0, 0.3, { ...pad, shape: "rect" })).toBe(true);
    expect(release.holeMeetsPad(0.9, 0, 0.3, { ...pad, shape: "rect" })).toBe(false);
    expect(release.holeMeetsPad(0, 0.5, 0.3, { ...pad, shape: "circle" })).toBe(true);
    expect(release.holeMeetsPad(0.7, 0.4, 0.1, { ...pad, shape: "oval" })).toBe(false);
    // an unmodelled shape is counted as copper within its reach, and ignored beyond it
    expect(release.holeMeetsPad(1.1, 0, 0.1, { ...pad, shape: "trapezoid" })).toBe(true);
    expect(release.holeMeetsPad(5, 0, 0.1, { ...pad, shape: "trapezoid" })).toBe(false);
    // a chamfered roundrect is tested as its rectangle
    expect(release.holeMeetsPad(0.5, 0.25, 0.05, { ...pad, shape: "roundrect", chamfered: true })).toBe(true);
    expect(release.holeMeetsPad(0.5, 0.25, 0.05, { ...pad, shape: "roundrect" })).toBe(false); // the rounded corner clears it
    // an arc primitive: a quarter arc of radius 1 around the pad centre, width 0.2
    const arcPad = { x: 0, y: 0, ang: 0, w: 0.1, h: 0.1, shape: "custom", anchor: "circle", primitives: [["gr_arc", ["start", "1", "0"], ["mid", "0.7071", "0.7071"], ["end", "0", "1"], ["width", "0.2"]]] as never };
    expect(release.holeMeetsPad(0.7071 * 1.1, 0.7071 * 1.1, 0.05, arcPad)).toBe(true); // on the sweep, beside the stroke
    expect(release.holeMeetsPad(-0.7071, -0.7071, 0.05, arcPad)).toBe(false); // on the circle, off the sweep
    expect(release.holeMeetsPad(0.5, 0.5, 0.05, arcPad)).toBe(false); // inside the circle, away from the stroke
  });
});

describe("CRLF boards", () => {
  test("top-level blocks are found after any whitespace, so CRLF boards edit like LF ones", () => {
    const lf = '(kicad_pcb\n\t(via\n\t\t(at 1 1)\n\t\t(net "A")\n\t)\n\t(segment\n\t\t(start 0 0)\n\t\t(net "A")\n\t)\n\t(via\t(at 2 2) (net "B"))\n)\n';
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(topLevelSpans(lf, "via")).toHaveLength(2);
    expect(topLevelSpans(crlf, "via")).toHaveLength(2);
    expect(topLevelSpans(crlf, "segment")).toHaveLength(1);
    const r = removeBlocks(crlf, "via", (b) => b.includes('(net "A")'));
    expect(r.removed).toBe(1);
    expect(r.text).not.toContain("(at 1 1)");
  });
});

describe("CAM helpers", () => {
  test("required layers: every copper layer, mask, silk, outline; paste only where SMD pads are", () => {
    const text = `(layers (0 "F.Cu" signal) (4 "In1.Cu" power) (2 "B.Cu" signal)) (pad "1" smd rect)`;
    expect(release.requiredLayers(text)).toEqual(["F.Cu", "In1.Cu", "B.Cu", "F.Mask", "B.Mask", "F.Silkscreen", "B.Silkscreen", "Edge.Cuts", "F.Paste", "B.Paste"]);
    expect(release.requiredLayers(`(layers (0 "F.Cu" signal) (2 "B.Cu" signal)) (pad "1" thru_hole circle)`)).not.toContain("F.Paste");
  });
  test("two exports of one board are the same file once the date lines are removed", () => {
    const mk = (date: string) => Buffer.from(`%TF.CreationDate,${date}*%\nG04 Created by KiCad (10) date ${date}*\nX1Y1D03*\n`);
    expect(release.normalisedHash(mk("2026-11-12T10:00:00"))).toBe(release.normalisedHash(mk("2026-11-12T10:00:09")));
    expect(release.normalisedHash(Buffer.from("X1Y1D03*\n"))).not.toBe(release.normalisedHash(Buffer.from("X1Y2D03*\n")));
  });
  test("zip: entries round-trip", async () => {
    const z = Buffer.from(release.zipFiles([{ name: "a.txt", data: new TextEncoder().encode("hello hello hello") }, { name: "d/b.bin", data: new Uint8Array([1, 2, 3]) }]));
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    const eocd = z.length - 22;
    expect(z.readUInt32LE(eocd)).toBe(0x06054b50);
    expect(z.readUInt16LE(eocd + 10)).toBe(2);
    const nameLen = z.readUInt16LE(26);
    const compLen = z.readUInt32LE(18);
    expect(z.subarray(30, 30 + nameLen).toString()).toBe("a.txt");
    expect(inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + compLen)).toString()).toBe("hello hello hello");
    expect(z.readUInt32LE(14)).toBe(release.crc32(new TextEncoder().encode("hello hello hello")));
  });
});

describe("release gates", () => {
  const cli = { path: "kicad-cli-not-used", version: "" };
  const pass = { pass: true, text: "ok" };
  const allPass = Object.fromEntries(["A1_connectivity", "A2_drc", "A3_parity", "A4_circuit", "A5_anchors", "A6_stack", "A7_widths", "A8_pairs", "A9_heights"].map((k) => [k, true]));
  async function setup(extra = "") {
    const dir = await mkdtemp(join(tmpdir(), "fab-"));
    await writeFile(join(dir, "b.kicad_pcb"), board(extra));
    return { dir, pcb: join(dir, "b.kicad_pcb"), out: join(dir, "pkg") };
  }
  const input = async (over: Partial<Parameters<typeof release.releaseFab>[0]> = {}, extra = "") => {
    const s = await setup(extra);
    const calls: string[] = [];
    const base = {
      project: s.dir, stem: "b", pcb: s.pcb, schematic: null, out: s.out, cli,
      gates: {
        interconnect: async () => (calls.push("interconnect"), pass),
        review: async () => (calls.push("review"), { state: "pass" as const }),
        acceptance: async () => (calls.push("acceptance"), { summary: allPass }),
      },
    };
    return { s, calls, inp: { ...base, ...over } as Parameters<typeof release.releaseFab>[0] };
  };
  const stopped = async (inp: Parameters<typeof release.releaseFab>[0]) => {
    try {
      await release.releaseFab(inp);
    } catch (e) {
      return e as release.ReleaseStop;
    }
    throw new Error("released");
  };

  test("the interconnect gate comes first and stops everything, writing nothing", async () => {
    const { s, calls, inp } = await input();
    inp.gates.interconnect = async () => (calls.push("interconnect"), { pass: false, text: "J1 interface not PASS" });
    const e = await stopped(inp);
    expect(e.gate).toBe("interconnect");
    expect(calls).toEqual(["interconnect"]);
    expect(await stat(s.out).catch(() => null)).toBeNull();
  });
  test("a standalone project records 'interconnect: none' and goes on to the review gate", async () => {
    const { s, calls, inp } = await input();
    delete (inp.gates as { interconnect?: unknown }).interconnect;
    inp.gates.review = async () => (calls.push("review"), { state: "open", open: 3, mustFix: 1 });
    const e = await stopped(inp);
    expect(e.gate).toBe("review");
    expect(e.message).toContain("3 findings open (1 must-fix)");
    expect(calls).toEqual(["review"]);
    expect(await stat(s.out).catch(() => null)).toBeNull();
  });
  for (const state of ["none", "stale", "errors"] as const)
    test(`review gate '${state}' refuses before acceptance runs`, async () => {
      const { calls, inp } = await input();
      inp.gates.review = async () => (calls.push("review"), { state });
      expect((await stopped(inp)).gate).toBe("review");
      expect(calls).toEqual(["interconnect", "review"]);
    });
  test("acceptance: a failing check refuses; an owner-decided exception lets exactly that check through", async () => {
    const { s, inp } = await input();
    inp.gates.acceptance = async () => ({ summary: { ...allPass, A8_pairs: false } });
    const e = await stopped(inp);
    expect(e.gate).toBe("acceptance");
    expect(e.message).toContain("A8_pairs");
    expect(await stat(s.out).catch(() => null)).toBeNull();
    // the exception needs an owner decision with that id in the named file
    await writeFile(join(s.dir, "d.json"), JSON.stringify({ decisions: [{ id: "pair-spacing", by: "owner", decision: "accepted" }, { id: "x", by: "agent" }] }));
    const ex = await release.resolveException("A8_pairs=d.json#pair-spacing", s.dir);
    expect(ex).toEqual({ check: "A8_pairs", decision: "d.json#pair-spacing", text: "accepted" });
    await expect(release.resolveException("A8_pairs=d.json#x", s.dir)).rejects.toThrow(/no owner decision/);
    // with the exception the run moves on to the via gate (vias are fine here), then needs kicad-cli: it fails there, not at acceptance
    inp.accept = [ex];
    const e2 = await release.releaseFab(inp).catch((x) => x as Error);
    expect((e2 as { gate?: string }).gate).not.toBe("acceptance");
  });
  test("via-in-pad without native fill and cap refuses with the vias named", async () => {
    const { inp } = await input({}, `(via micro (at 26 26) (size 0.3) (drill 0.1) (layers "F.Cu" "In1.Cu") (net "A") (uuid "v3"))`);
    const e = await stopped(inp);
    expect(e.gate).toBe("vias");
    expect(e.message).toContain("1 via(s)");
  });
  test("a BOM check of another board refuses before any export; an exception file outside the project refuses", async () => {
    const { s, inp } = await input();
    const bom = join(s.dir, "bom");
    await mkdir(bom, { recursive: true });
    await writeFile(join(bom, "cpl-jlc.csv"), "ref\n");
    const e = await stopped({ ...inp, bomDir: bom, bomBoardSha: "0".repeat(64) });
    expect(e.gate).toBe("bom");
    expect(await stat(s.out).catch(() => null)).toBeNull();
    const outside = await mkdtemp(join(tmpdir(), "dec-"));
    await writeFile(join(outside, "d.json"), JSON.stringify([{ id: "x", by: "owner", decision: "ok" }]));
    const ex = await release.resolveException(`A8_pairs=${join(outside, "d.json")}#x`, s.dir).catch((x) => x as release.ReleaseStop);
    expect(ex).toBeInstanceOf(release.ReleaseStop);
    expect((ex as release.ReleaseStop).message).toContain("outside the project");
  });
  test.skipIf(process.platform === "win32")("a refusal after CAM started leaves no package, zip or temporary folder", async () => {
    const { s, inp } = await input();
    const bom = join(s.dir, "bom");
    await release.bomCheck({ project: s.dir, stem: "b", out: bom, fetch: { transport: transport([]), shared: null, paceMs: 0 } });
    inp.bomDir = bom;
    inp.bomBoardSha = release.sha256(await readFile(s.pcb));
    // a kicad-cli whose exports differ every time: the reproducibility check refuses after files were written
    const fake = join(await mkdtemp(join(tmpdir(), "fakecli-")), "kicad-cli");
    await writeFile(fake, `#!/bin/sh\nout=""; prev=""\nfor a in "$@"; do if [ "$prev" = "--output" ]; then out="$a"; fi; prev="$a"; done\ncase "$out" in */) mkdir -p "$out"; echo "$$ $(date +%N)" > "$out/b-F_Cu.gbr" ;; *) echo x > "$out" ;; esac\nexit 0\n`);
    await chmod(fake, 0o755);
    const out = join(s.dir, "exports", "pkg");
    const e = await stopped({ ...inp, out, cli: { path: fake, version: "fake" } });
    expect(e.gate).toBe("cam");
    expect(await stat(out).catch(() => null)).toBeNull();
    expect(await stat(join(s.dir, "exports")).catch(() => null)).toBeNull();
    expect((await readdir(s.dir)).sort()).toEqual(["b.kicad_pcb", "bom"]);
  });
});

describe("gated BOM completeness", () => {
  for (const status of ["UNRESOLVED", "PROPOSED", "OWNER"]) test(`${status} fitted choices refuse before export`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fab-bom-gate-"));
    const pcb = join(dir, "b.kicad_pcb"), bomDir = join(dir, "bom"), out = join(dir, "package");
    await writeFile(pcb, board());
    const bom = await release.bomCheck({ project: dir, stem: "b", out: bomDir, fetch: { transport: transport([]), shared: null, paceMs: 0 } });
    bom.records.find(record => record.refs.includes("R1"))!.status = status;
    await writeFile(join(bomDir, "bom-decisions.json"), JSON.stringify(bom));
    const result = await release.releaseFab({ project: dir, stem: "b", pcb, schematic: null, out, cli: { path: "must-not-export", version: "" }, bomDir, bomBoardSha: release.sha256(await readFile(pcb)), gates: { review: async () => ({ state: "pass" }), acceptance: async () => ({ summary: Object.fromEntries(["A1_connectivity", "A2_drc", "A3_parity", "A4_circuit", "A5_anchors", "A6_stack", "A7_widths", "A8_pairs", "A9_heights"].map(key => [key, true])) }) } }).catch(error => error as release.ReleaseStop);
    expect(result).toBeInstanceOf(release.ReleaseStop);
    expect((result as release.ReleaseStop).gate).toBe("bom");
    expect((result as release.ReleaseStop).message).toContain("R1");
    expect(await stat(out).catch(() => null)).toBeNull();
    expect((await readdir(dir)).sort()).toEqual(["b.kicad_pcb", "bom"]);
  });
  for (const assembly of [true, false]) test(`no BOM check ${assembly ? "stops an assembly order" : "is not required for a bare-board order"}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "fab-bare-"));
    const pcb = join(dir, "b.kicad_pcb"), out = join(dir, "package");
    await writeFile(pcb, board());
    const result = await release.releaseFab({ project: dir, stem: "b", pcb, schematic: null, out, assembly, cli: { path: "must-not-export", version: "" }, gates: { review: async () => ({ state: "pass" }), acceptance: async () => ({ summary: Object.fromEntries(["A1_connectivity", "A2_drc", "A3_parity", "A4_circuit", "A5_anchors", "A6_stack", "A7_widths", "A8_pairs", "A9_heights"].map(key => [key, true])) }) } }).catch(error => error as Error);
    // a bare-board order goes past the BOM gate to CAM (which this fake kicad-cli cannot export)
    expect(result instanceof release.ReleaseStop && result.gate === "bom").toBe(assembly);
  });
  test("complete choices include copper-only exceptions, but missing fitted references refuse", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fab-bom-coverage-"));
    await writeFile(join(dir, "b.kicad_pcb"), board());
    const bom = await release.bomCheck({ project: dir, stem: "b", out: join(dir, "bom"), fetch: { transport: transport([]), shared: null, paceMs: 0 } });
    expect(() => release.assertReleaseBom(bom, board())).not.toThrow();
    bom.records = bom.records.filter(record => !record.refs.includes("R2"));
    expect(() => release.assertReleaseBom(bom, board())).toThrow("R2 (missing)");
  });
});
