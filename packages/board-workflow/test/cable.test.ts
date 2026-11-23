import { describe, expect, test } from "bun:test";
import { cable } from "../src/index";

/** A 40 x 30 board with one connector: courtyard 4 x 6 mm, contact pads at its -X side, so the mouth faces +X at rot 0. */
function board(ref: string, x: number, y: number, rot: number): string {
  return `(kicad_pcb (version 20240108)
 (gr_rect (start 0 0) (end 40 30) (layer "Edge.Cuts"))
 (footprint "Conn:FFC" (layer "F.Cu") (at ${x} ${y} ${rot})
  (property "Reference" "${ref}")
  (fp_rect (start -2 -3) (end 2 3) (layer "F.CrtYd"))
  (pad "1" smd rect (at -1.5 -1) (size 0.5 1) (layers "F.Cu"))
  (pad "2" smd rect (at -1.5 1) (size 0.5 1) (layers "F.Cu"))
  (pad "MP" smd rect (at 1.5 -2.5) (size 1 1) (layers "F.Cu"))))
`;
}

function boards(files: Record<string, string>) {
  return new cable.CableBoards("/proj", async (p) => {
    const t = files[p];
    if (t === undefined) throw new Error(`missing ${p}`);
    return t;
  });
}

const frame = (bOrigin: [number, number], yaw = 0, mirror = false): cable.ChassisFrame => ({
  boards: {
    A: { pcb: "a.kicad_pcb", origin: [0, 0], face_z: { F: 1.0, B: 0 } },
    B: { pcb: "b.kicad_pcb", origin: bOrigin, yaw, ...(mirror ? { mirror } : {}), face_z: { F: 1.6, B: 0 } },
  },
});

describe("cable reach (cablepath)", () => {
  test("turns counts direction changes and reversals", () => {
    expect(cable.turns([1, 0], [10, 0], [1, 0])).toBe(0);
    expect(cable.turns([1, 0], [10, 5], [0, 1])).toBe(1);
    expect(cable.turns([1, 0], [-10, 0], [-1, 0])).toBe(2);
    expect(cable.turns([1, 0], [0.2, 0.3], [-1, 0])).toBe(2);
  });

  test("toChassis mirrors before the yaw and adds the origin", () => {
    expect(cable.toChassis({ pcb: "", origin: [10, 5] }, [1, 2])).toEqual([11, 7]);
    const p = cable.toChassis({ pcb: "", origin: [0, 0], yaw: 90 }, [1, 0]);
    expect(p[0]).toBeCloseTo(0, 12);
    expect(p[1]).toBeCloseTo(1, 12);
    expect(cable.toChassis({ pcb: "", origin: [0, 0], mirror: true }, [3, 4], true)).toEqual([-3, 4]);
  });

  test("two facing connectors: straight run, PASS with the expected slack", async () => {
    // A: J1 at the right edge (mouth +X at x=40); B: J2 rotated 180 (mouth -X) at the left edge of a board 20 mm further on
    const bs = boards({ "/proj/a.kicad_pcb": board("J1", 38, 15, 0), "/proj/b.kicad_pcb": board("J2", 2, 15, 180) });
    const cab: cable.Cable = { id: "ffc", a: ["A", "J1"], b: ["B", "J2"], length_mm: 40, tolerance_mm: 1, lead_mm: 3, bend_mm: 1.5 };
    const r = await cable.checkCable(bs, frame([60, 0]), cab);
    expect(r.ends.map((e) => [e.mouth, e.normal])).toEqual([[[40, 15], [1, 0]], [[60, 15], [-1, 0]]]);
    // leads 3 + 3, run 20 - 6 = 14, dz 0.6, no turns
    expect(r.turns).toBe(0);
    expect(r.run_dx_mm).toBe(14);
    expect(r.required_mm).toBe(20.6);
    expect(r.slack_mm).toBe(18.4);
    expect(r.verdict).toBe("PASS");
    expect(r.flags).toEqual([]);
    expect(cable.cableLine("f", r)).toBe("f              ffc      PASS  need   20.6 mm  have 40.0-1.0  slack  +18.4  turns 0  run +14.0,+0.0 dz 0.6");
  });

  test("a short cable fails, a long one is flagged for a fold store, an inboard mouth is flagged", async () => {
    const bs = boards({ "/proj/a.kicad_pcb": board("J1", 20, 15, 0), "/proj/b.kicad_pcb": board("J2", 2, 15, 180) });
    const short = await cable.checkCable(bs, frame([60, 0]), { id: "s", a: ["A", "J1"], b: ["B", "J2"], length_mm: 20 });
    expect(short.verdict).toBe("FAIL");
    expect(short.flags).toEqual(["J1 mouth is 18.0 mm inside its board edge (cable crosses its own board)"]);
    const long = await cable.checkCable(bs, frame([60, 0]), { id: "l", a: ["A", "J1"], b: ["B", "J2"], length_mm: 200 });
    expect(long.flags.at(-1)).toMatch(/^excess \d+ mm needs a fold store$/);
  });

  test("runCables: frames, pcb override, failed count; sweep slides the connector along the edge", async () => {
    const bs = boards({ "/proj/a.kicad_pcb": board("J1", 38, 15, 0), "/proj/a2.kicad_pcb": board("J1", 20, 15, 0), "/proj/b.kicad_pcb": board("J2", 2, 15, 180) });
    const ch: cable.Chassis = { frames: { near: frame([60, 0]), far: frame([200, 0]) }, cables: [{ id: "ffc", a: ["A", "J1"], b: ["B", "J2"], length_mm: 40 }] };
    const r = await cable.runCables(bs, structuredClone(ch));
    expect(Object.keys(r.results)).toEqual(["near", "far"]);
    expect(r.failed).toBe(1);
    const o = await cable.runCables(bs, structuredClone(ch), { frame: "near", pcb: { A: "a2.kicad_pcb" } });
    expect(o.results["near"]![0]!.ends[0]!.mouth).toEqual([22, 15]);
    await expect(cable.runCables(bs, structuredClone(ch), { frame: "nope" })).rejects.toThrow(/no frame nope/);
    const rows = await cable.sweepCable(bs, structuredClone(ch), "A", "J1", "right", { step: 5 });
    expect(rows.map((x) => x.pos)).toEqual([3, 8, 13, 18, 23]);
    expect(rows.every((x) => x.pose[0] === 38 && x.pose[2] === 0)).toBe(true);
    // the far frame's slack is the same at every height except for the turns; the row closest to y=15 is best in "near"
    const best = rows.reduce((p, q) => (q.slack["near:ffc"]! > p.slack["near:ffc"]! ? q : p));
    expect(best.pos).toBe(13);
    expect(cable.sweepLines(rows)[0]).toContain("near:ffc");
    await expect(cable.sweepCable(bs, structuredClone(ch), "A", "J1", "up" as cable.Edge)).rejects.toThrow(/edge must be/);
  });

  test("a hand-written chassis gets messages that name the field", () => {
    expect(() => cable.validateChassis({ frames: {}, cables: [] })).toThrow(/needs frames/);
    expect(() => cable.validateChassis({ frames: { f: { boards: { A: { pcb: "x" } } } }, cables: [] })).toThrow(/board A needs pcb and origin/);
    expect(() => cable.validateChassis({ frames: { f: { boards: {} } }, cables: [{ id: "c" }] })).toThrow(/every cable needs/);
  });

  test("no outline and no contact pads are refused", () => {
    expect(() => cable.cableBoard("(kicad_pcb)", "x")).toThrow(/no Edge.Cuts outline/);
    const b = cable.cableBoard(board("J1", 5, 5, 0).replace(/\(pad "[12]"[^\n]*\n/g, ""));
    expect(() => cable.cableMouth(b, "J1")).toThrow(/no signal pads/);
    expect(() => cable.cableMouth(b, "J9")).toThrow(/no such footprint/);
  });
});
