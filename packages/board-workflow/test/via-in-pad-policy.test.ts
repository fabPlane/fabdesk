import { describe, expect, test } from "bun:test";
import { classifyVias, newViasInPads, viaInPadPolicy, viaInPadReport } from "../src/release/viaproc";
import { krtClaim, tmClaim, tracemakerKeepsViasOffPads, TM_KEEP_VIAS_OFF_PADS } from "../src/layout/route";
import { claimsOf } from "../src/lastmile/bench";

const board = (vias: string) => `(kicad_pcb (version 20250114)
	(layers (0 "F.Cu" signal) (2 "B.Cu" signal))
	(footprint "Lib:R" (layer "F.Cu") (at 10 10 0)
		(property "Reference" "R1" (at 0 0))
		(pad "1" smd rect (at -1 0) (size 0.8 0.8) (layers "F.Cu" "F.Paste") (net "SIG"))
		(pad "2" smd rect (at 1 0) (size 0.8 0.8) (layers "F.Cu" "F.Paste") (net "GND")))
	${vias}
)`;
const via = (x: number, y: number, net: string, uuid: string) => `(via (at ${x} ${y}) (size 0.5) (drill 0.3) (layers "F.Cu" "B.Cu") (net "${net}") (uuid "${uuid}"))`;

describe("via-in-pad policy", () => {
  test("only allow:true with a non-empty basis allows via-in-pad", () => {
    expect(viaInPadPolicy(undefined).allowed).toBe(false);
    expect(viaInPadPolicy({ allow: true }).allowed).toBe(false);
    expect(viaInPadPolicy({ allow: true, basis: "  " }).allowed).toBe(false);
    expect(viaInPadPolicy({ allow: false, basis: "x" }).allowed).toBe(false);
    expect(viaInPadPolicy({ allow: true, basis: " filled+capped, quoted by fab " })).toEqual({ allowed: true, basis: "filled+capped, quoted by fab" });
  });

  test("new vias in pads: a via already in the same pads on the same net is not new, even with a new uuid", () => {
    const before = classifyVias(board(via(9, 10, "SIG", "a") + via(20, 20, "SIG", "b")));
    // the SIG via re-created in R1.1 (new uuid), a new GND via in R1.2, a new via clear of every pad
    const after = classifyVias(board(via(9.1, 10, "SIG", "c") + via(11, 10, "GND", "d") + via(25, 25, "SIG", "e")));
    expect(newViasInPads(before, after).map((v) => [v.net, v.in_component_lands])).toEqual([["GND", ["R1.2"]]]);
  });

  test("the report names each new via in a pad and what to do, by policy", () => {
    const before = board("");
    const after = board(via(11, 10, "GND", "d"));
    const avoid = viaInPadReport(before, after, viaInPadPolicy(undefined));
    expect(avoid.vias).toEqual([{ net: "GND", x: 11, y: 10, lands: ["R1.2"] }]);
    expect(avoid.text).toContain("1 new via(s) in solder pads, not allowed");
    expect(avoid.text).toContain("GND at (11, 10) in R1.2");
    expect(avoid.text).toContain("manufacturing_rules.via_in_pad {allow:true,basis}");
    const allowed = viaInPadReport(before, after, viaInPadPolicy({ allow: true, basis: "BGA escape" }));
    expect(allowed.allowed).toBe(true);
    expect(allowed.text).toContain("allowed by manufacturing_rules.via_in_pad (BGA escape)");
    expect(viaInPadReport(before, board(via(30, 30, "GND", "x")), viaInPadPolicy(undefined)).text).toBe("Via-in-pad: no new vias in solder pads.");
  });
});

describe("TraceMaker via options", () => {
  test("keep-off options cover every SMD pad and are used only when the build offers them", () => {
    expect(TM_KEEP_VIAS_OFF_PADS).toEqual(["--keep-vias-off-pads", "--vias-off-pads-below", "1000"]);
    expect(tracemakerKeepsViasOffPads("  --keep-vias-off-pads\n  --vias-off-pads-below FLOAT")).toBe(true);
    expect(tracemakerKeepsViasOffPads("  --via-in-pad\n")).toBe(false);
  });
});

describe("router claims", () => {
  test("KRT: the last stage with a compact tally", () => {
    const rec = { stages: [{ name: "route", JSON_SUMMARY_MIN: { successful: 8, failed: 2 } }, { name: "diff", skipped: "nothing selected" }, { name: "finish", JSON_SUMMARY_MIN: { successful: 10, failed: 0 } }] };
    expect(krtClaim(rec)).toEqual({ router: "krt", routed: 10, failed: 0, text: "KRT claimed 10 routed, 0 failed (stage finish)" });
    expect(krtClaim({ stages: [{ name: "route", exit: 1 }] })).toBeNull();
    expect(krtClaim(null)).toBeNull();
  });

  test("TraceMaker: the CLI summary, else the last session stage", () => {
    expect(tmClaim({ stages: [{ stage: "pairs", open_after: 3 }, { stage: "cli", summary: "routed 41/44 connections, 12 tracks" }] })).toMatchObject({ routed: 41, total: 44, failed: 3, text: "TraceMaker claimed 41/44 routed" });
    expect(tmClaim({ stages: [{ stage: "pairs", open_after: 3 }] })).toMatchObject({ failed: 3, text: "TraceMaker claimed 3 open after session stage pairs" });
    expect(tmClaim({ stages: [] })).toBeNull();
  });

  test("a bench candidate lists its steps' claims, marked as the router's own", () => {
    expect(claimsOf({ steps: [{ type: "fill", claim: { router: "freerouting", routed: 5, total: 6, text: "freerouting claimed 5/6 routed" } }, { type: "pairfix" }] })).toBe(
      "router claimed: freerouting claimed 5/6 routed (the open count before it is native)",
    );
    expect(claimsOf({ steps: [{ type: "pairfix" }] })).toBe("");
  });
});
