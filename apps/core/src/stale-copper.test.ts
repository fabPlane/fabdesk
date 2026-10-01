import { describe, expect, test } from "bun:test";
import { BoardLayer } from "@fp-pcb/proto";
import {
  analyzeStaleCopper,
  type CopperPad,
  type CopperPolygon,
  type CopperRoute,
} from "./stale-copper";

const F = BoardLayer.BL_F_Cu;
const B = BoardLayer.BL_B_Cu;

function square(x: number, y = 0, half = 1): CopperPolygon {
  return {
    outline: [
      { x: x - half, y: y - half },
      { x: x + half, y: y - half },
      { x: x + half, y: y + half },
      { x: x - half, y: y + half },
    ],
  };
}

function pad(id: string, number: string, net: string, x: number, layers = [F]): CopperPad {
  return {
    id,
    parent: "fp",
    reference: "J1",
    number,
    net,
    shapes: layers.map((layer) => ({ layer, polygon: square(x) })),
  };
}

function track(id: string, net: string, start: number, end: number, layer = F): CopperRoute {
  return {
    id,
    kind: "track",
    net,
    layers: [layer],
    path: [
      { x: start, y: 0 },
      { x: end, y: 0 },
    ],
    width: 0.2,
    locked: false,
  };
}

function analyze(
  beforePads: CopperPad[],
  afterPads: CopperPad[],
  routes: CopperRoute[],
  otherPads: CopperPad[] = [],
) {
  return analyzeStaleCopper({
    beforePads,
    afterPads,
    allPadsBefore: [...beforePads, ...otherPads],
    allPadsAfter: [...afterPads, ...otherPads],
    routes,
    zones: [],
  });
}

describe("stale footprint fan-out copper", () => {
  test("a 180 degree connector rotation reports each old fan-out as stale and shorted", () => {
    const before = [pad("p1", "1", "A", 0), pad("p2", "2", "B", 10)];
    const after = [pad("p1", "1", "A", 10), pad("p2", "2", "B", 0)];
    const result = analyze(before, after, [track("ta", "A", 0, -5), track("tb", "B", 10, 15)]);
    expect(result.staleIds).toEqual(["ta", "tb"]);
    expect(result.reports.J1?.staleCount).toBe(2);
    expect(result.reports.J1?.shortedCount).toBe(2);
    expect(result.reports.J1?.nets).toEqual(["A", "B"]);
  });

  test("counts copper items once when one item touches multiple pads", () => {
    const before = [pad("p1", "1", "A", 0), pad("p2", "2", "A", 0)];
    const after = [pad("p1", "1", "A", 10), pad("p2", "2", "A", 10)];
    const result = analyze(before, after, [track("stale", "A", 0, -5), track("foreign", "B", 5, 15)]);
    expect(result.reports.J1?.stale).toHaveLength(2);
    expect(result.reports.J1?.staleCount).toBe(1);
    expect(result.reports.J1?.shorted).toHaveLength(2);
    expect(result.reports.J1?.shortedCount).toBe(1);
  });

  test("a pad-to-segment-to-segment chain stops before its first via", () => {
    const before = [pad("p1", "1", "A", 0)];
    const after = [pad("p1", "1", "A", -10)];
    const via: CopperRoute = {
      id: "via",
      kind: "via",
      net: "A",
      layers: [F, B],
      path: [{ x: 10, y: 0 }],
      width: 1,
      locked: false,
    };
    const result = analyze(before, after, [
      track("s1", "A", 0, 5),
      track("s2", "A", 5, 10),
      via,
      track("past", "A", 10, 15, B),
    ]);
    expect(result.staleIds).toEqual(["s1", "s2"]);
  });

  test("a three-way junction preserves both branches", () => {
    const before = [pad("p1", "1", "A", 0)];
    const after = [pad("p1", "1", "A", -10)];
    const branch1 = track("b1", "A", 5, 10);
    branch1.path[1]!.y = 5;
    const branch2 = track("b2", "A", 5, 10);
    branch2.path[1]!.y = -5;
    const result = analyze(before, after, [track("stem", "A", 0, 5), branch1, branch2]);
    expect(result.staleIds).toEqual(["stem"]);
  });

  test("an unchanged pad produces no stale copper", () => {
    const before = [pad("p1", "1", "A", 0)];
    const result = analyze(before, before, [track("t", "A", 0, 5)]);
    expect(result).toEqual({ reports: {}, staleIds: [], affectedNets: [] });
  });

  test("unrelated copper under the moved pad is shorted but never removable", () => {
    const before = [pad("p1", "1", "A", 0)];
    const after = [pad("p1", "1", "A", 20)];
    const result = analyze(before, after, [track("foreign", "B", 15, 25)]);
    expect(result.staleIds).toEqual([]);
    expect(result.reports.J1?.staleCount).toBe(0);
    expect(result.reports.J1?.shorted.map((item) => item.id)).toEqual(["foreign"]);
  });

  test("a flipped through-hole pad remains attached on its actual shared copper layer", () => {
    const before = [pad("p1", "1", "A", 0, [F, B])];
    const after = [pad("p1", "1", "A", 0, [B, F])];
    const result = analyze(before, after, [track("back", "A", 0, 5, B)]);
    expect(result.staleIds).toEqual([]);
    expect(result.reports).toEqual({});
  });

  test("a via in pad is included but copper beyond it is preserved", () => {
    const before = [pad("p1", "1", "A", 0, [F, B])];
    const after = [pad("p1", "1", "A", -10, [F, B])];
    const via: CopperRoute = {
      id: "via-in-pad",
      kind: "via",
      net: "A",
      layers: [F, B],
      path: [{ x: 0, y: 0 }],
      width: 1,
      locked: true,
    };
    const result = analyze(before, after, [via, track("beyond", "A", 0, 5, B)]);
    expect(result.staleIds).toEqual(["via-in-pad"]);
    expect(result.reports.J1?.stale[0]?.locked).toBe(true);
  });
});
