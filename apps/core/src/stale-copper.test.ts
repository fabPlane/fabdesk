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
    shapes: layers.map((layer) => ({ layer, exact: "rect-pad", polygon: square(x) })),
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

  test("a two-track chain continues through its via across layers", () => {
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
    expect(result.staleIds).toEqual(["past", "s1", "s2", "via"]);
  });

  test("a three-way junction preserves both branches", () => {
    const before = [pad("p1", "1", "A", 0)];
    const after = [pad("p1", "1", "A", -10)];
    const branch1 = track("b1", "A", 5, 10);
    branch1.path[1]!.y = 5;
    const branch2 = track("b2", "A", 5, 10);
    branch2.path[1]!.y = -5;
    const otherPads = [5, -5].map((y, i): CopperPad => ({ ...pad(`other${i}`, "1", "A", 10), parent: `other${i}`,
      shapes: [{ layer: F, exact: "rect-pad", polygon: square(10, y) }] }));
    const result = analyze(before, after, [track("stem", "A", 0, 5), branch1, branch2], otherPads);
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

  test("a via in pad and its dangling continuation are both leaves", () => {
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
    expect(result.staleIds).toEqual(["beyond", "via-in-pad"]);
    expect(result.reports.J1?.stale.find(item => item.id === "via-in-pad")?.locked).toBe(true);
  });
});

test("a dangling via with one track is removable; other parts' pads stop the chain", () => {
  const before = [pad("p1", "1", "A", 0)], after = [pad("p1", "1", "A", -10)];
  const via: CopperRoute = { id: "v", kind: "via", net: "A", layers: [F, B], path: [{ x: 5, y: 0 }], width: 1, locked: false };
  expect(analyze(before, after, [track("s", "A", 0, 5), via]).staleIds).toEqual(["s", "v"]);
  const other = { ...pad("other", "1", "A", 5), parent: "other", reference: "U2" };
  expect(analyze(before, after, [track("s", "A", 0, 5), via], [other]).staleIds).toEqual(["s"]);
});

test("a via at a T across layers preserves the branch and via", () => {
  const before = [pad("p1", "1", "A", 0)], after = [pad("p1", "1", "A", -10)];
  const via: CopperRoute = { id: "v", kind: "via", net: "A", layers: [F, B], path: [{ x: 5, y: 0 }], width: 1, locked: false };
  const branch = track("branch", "A", 5, 10, B); branch.path[1]!.y = 5;
  expect(analyze(before, after, [track("s", "A", 0, 5), via, track("next", "A", 5, 10, B), branch]).staleIds).toEqual(["s"]);
});

test("a via meeting a zone on its other layer stops traversal", () => {
  const before = [pad("p1", "1", "A", 0)], after = [pad("p1", "1", "A", -10)];
  const via: CopperRoute = { id: "v", kind: "via", net: "A", layers: [F, B], path: [{ x: 5, y: 0 }], width: 1, locked: false };
  const r = analyzeStaleCopper({ beforePads: before, afterPads: after, allPadsBefore: before, allPadsAfter: after,
    routes: [track("s", "A", 0, 5), via, track("next", "A", 5, 10, B)], zones: [{ layer: B, polygons: [square(5)] }] });
  expect(r.staleIds).toEqual(["s"]);
});

// Real nanometre coordinates keep the 1 nm connectivity tolerance out of these cases.
describe("via copper contacts across its spanned layers", () => {
  const mm = 1e6;
  const p = (x: number, y: number) => ({ x: x * mm, y: y * mm });
  const before: CopperPad = { ...pad("moving", "1", "A", 0), shapes: [{ layer: F, exact: "rect-pad", polygon: square(0, 0, .4 * mm) }] };
  const after: CopperPad = { ...before, shapes: [{ layer: F, exact: "rect-pad", polygon: square(-10 * mm, 0, .4 * mm) }] };
  const route = (id: string, a: [number, number], b: [number, number], layer = B): CopperRoute =>
    ({ ...track(id, "A", 0, 0, layer), path: [p(...a), p(...b)], width: .2 * mm });
  const via: CopperRoute = { id: "via", kind: "via", net: "A", layers: [F, B], path: [p(5, 0)], width: .8 * mm, locked: false };
  const stem = route("old-fanout", [0, 0], [5, 0], F);
  const next = route("live-next", [5, 0], [10, 0]);
  const run = (extra: CopperRoute[] = [], polygon?: CopperPolygon, zone = false, layer = B) => {
    const other: CopperPad = { ...before, id: "other", parent: "other", reference: "U2", shapes: polygon && !zone ? [{ layer, polygon }] : [] };
    return analyzeStaleCopper({ beforePads: [before], afterPads: [after], allPadsBefore: [before, other], allPadsAfter: [after, other],
      routes: [stem, via, next, ...extra], zones: polygon && zone ? [{ layer, polygons: [polygon] }] : [] }).staleIds;
  };
  test("an unsplit track interior is a junction", () => {
    expect(run([route("live-unsplit", [5, -5], [5, 5])])).toEqual(["old-fanout"]);
  });
  test("an unsplit T downstream of a traversed via preserves the onward branch", () => {
    const otherPads = [[15, 0], [10, 5], [10, -5]].map(([x, y], i): CopperPad => ({
      ...before, id: `U${i}`, parent: `U${i}`, reference: `U${i}`,
      shapes: [{ layer: B, exact: "rect-pad", polygon: square(x! * mm, y! * mm, .4 * mm) }],
    }));
    for (const kind of ["track", "arc"] as const) {
      const unsplit = { ...route("live-unsplit", [10, -5], [10, 5]), kind,
        path: kind === "arc" ? [p(11, -5), p(10, 0), p(11, 5)] : [p(10, -5), p(10, 5)] };
      const result = analyzeStaleCopper({ beforePads: [before], afterPads: [after],
        allPadsBefore: [before, ...otherPads], allPadsAfter: [after, ...otherPads],
        routes: [stem, via, route("continuation", [5, 0], [10, 0]), route("live-right", [10, 0], [15, 0]), unsplit], zones: [] });
      expect(result.staleIds).toEqual(kind === "arc" ? ["old-fanout"] : ["continuation", "old-fanout", "via"]);
    }
  });
  for (const interior of ["pad", "unsplit branch"] as const) {
    test(`a ${interior} inside the traversed continuation preserves live copper`, () => {
      const positions = interior === "pad" ? [[7, 0], [15, 0]] : [[15, 0], [7, -5], [7, 5]];
      const others = positions.map(([x, y], i): CopperPad => ({ ...before, id: `U${i}`, parent: `U${i}`, reference: `U${i}`,
        shapes: [{ layer: B, exact: "rect-pad", polygon: square(x! * mm, y! * mm, .3 * mm) }] }));
      const result = analyzeStaleCopper({ beforePads: [before], afterPads: [after], allPadsBefore: [before, ...others], allPadsAfter: [after, ...others],
        routes: [stem, via, route("continuation", [5, 0], [10, 0]), route("live-right", [10, 0], [15, 0]),
          ...(interior === "unsplit branch" ? [route("live-unsplit", [7, -5], [7, 5])] : [])], zones: [] });
      expect(result.staleIds).toEqual(["old-fanout", "via"]);
    });
  }
  test("one unsplit track alone supplies two continuing branches", () => {
    const unsplit = route("live-unsplit", [5, -5], [5, 5]);
    const result = analyzeStaleCopper({ beforePads: [before], afterPads: [after], allPadsBefore: [before], allPadsAfter: [after], routes: [stem, via, unsplit], zones: [] });
    expect(result.staleIds).toEqual(["old-fanout"]);
  });
  test("an arc interior contacting the annulus is a junction", () => {
    expect(run([{ ...route("arc", [4, -2], [4, 2]), kind: "arc", path: [p(4, -2), p(5.35, 0), p(4, 2)] }])).toEqual(["old-fanout"]);
  });
  for (const zone of [false, true]) {
    const kind = zone ? "filled zone" : "pad";
    test(`off-centre ${kind} touches the annulus`, () => {
      expect(run([], square(5 * mm, .6 * mm, .3 * mm), zone)).toEqual(["old-fanout"]);
    });
    test(`${kind} hole protects the via only until its continuation reaches solid copper`, () => {
      const outline = square(5 * mm, 0, 2 * mm).outline;
      // Unknown pad circles include the hole; zone outlines still preserve it.
      expect(run([], { outline, holes: [square(5 * mm, 0, .6 * mm).outline] }, zone)).toEqual(zone ? ["old-fanout", "via"] : ["old-fanout"]);
      expect(run([], { outline, holes: [square(5 * mm, 0, .3 * mm).outline] }, zone)).toEqual(["old-fanout"]);
    });
    test(`${kind} on an unspanned layer does not stop traversal`, () => {
      expect(run([], square(5 * mm, .6 * mm, .3 * mm), zone, BoardLayer.BL_In1_Cu)).toEqual(["live-next", "old-fanout", "via"]);
    });
  }
  test("a narrow filled thermal spoke contacting only the annulus stops traversal", () => {
    const spoke = { outline: [p(5.3, -.05), p(6, -.05), p(6, .05), p(5.3, .05)] };
    expect(run([], spoke, true)).toEqual(["old-fanout"]);
  });
});

test("native endpoint cap preserves the only bridge between two stationary pads", () => {
  const mm = 1e6;
  const before = pad("moving", "1", "A", 0), after = pad("moving", "1", "A", -10 * mm);
  const others = [.15, -.15].map((y, i): CopperPad => ({ ...pad(`U${i}`, "1", "A", 0),
    shapes: [{ layer: B, exact: "rect-pad", polygon: square(5.53 * mm, y * mm, .1 * mm) }] }));
  const via: CopperRoute = { id: "via", kind: "via", net: "A", layers: [F,B], path: [{x:5*mm,y:0}], width:.8*mm, locked:false };
  const stem = { ...track("old-fanout","A",0,5*mm), width:.2*mm };
  const bridge = { ...track("bridge","A",5.48*mm,10*mm,B), width:.2*mm };
  expect(analyze([before],[after],[stem,via,bridge],others).staleIds).toEqual(["old-fanout"]);
});

test("native outline cannot replace a seeded cap bridge between stationary pads", () => {
  const mm = 1e6;
  const before = pad("moving", "1", "A", 10 * mm, [B]), after = pad("moving", "1", "A", 20 * mm, [B]);
  const others = [.15, -.15].map((y, i): CopperPad => ({ ...pad(`U${i}`, "1", "A", 0),
    shapes: [{ layer: B, exact: "rect-pad", polygon: square(5.53 * mm, y * mm, .1 * mm) }] }));
  const bridge = { ...track("bridge", "A", 5.48 * mm, 10 * mm, B), width: .2 * mm };
  const polygon = { outline: [[5.35, -.4], [5.9, -.4], [5.9, .4], [5.35, .4]].map(([x, y]) => ({ x: x! * mm, y: y! * mm })) };
  const result = analyzeStaleCopper({ beforePads: [before], afterPads: [after],
    allPadsBefore: [before, ...others], allPadsAfter: [after, ...others], routes: [bridge],
    zones: [{ net: "A", layer: B, polygons: [polygon] }] });
  expect(result.staleIds).toEqual([]);
});

test("native unknown pad polygon cannot prove a replacement for a seeded cap bridge", () => {
  const land = (id: string, y: number): CopperPad => ({
    id, parent:id, reference:id, number:"1", net:"A",
    shapes:[{layer:F, exact:"rect-pad", polygon:square(0,y,.1)}],
  });
  const upper = land("upper",.15), lower = land("lower",-.15);
  const unknown: CopperPad = {...land("unknown",0), shapes:[{layer:F,polygon:square(0,0,.4),inner:null}]};
  const moving: CopperPad = {...land("moving",0), shapes:[{layer:F,polygon:square(5,0,.2)}]};
  const bridge = {...track("bridge","A",0,5),width:.2};
  const after = {...moving,shapes:[]};
  const result = analyzeStaleCopper({beforePads:[moving],afterPads:[after],allPadsBefore:[moving,upper,lower,unknown],
    allPadsAfter:[after,upper,lower,unknown],routes:[bridge],zones:[]});
  expect(result.staleIds).toEqual([]);
});

test("uncertified native pad box uses a circular retention envelope", () => {
  const moving = pad("moving","1","A",0);
  const route = track("tail","A",0,20);
  // The native polygon is an uncertain approximation. The circular box envelope
  // reaches this route even though its polygon corners do not.
  const other: CopperPad = { ...pad("other","1","A",10), shapes:[{layer:F,polygon:square(10,.75,.5)}] };
  expect(analyzeStaleCopper({beforePads:[moving],afterPads:[{...moving,shapes:[]}],allPadsBefore:[moving,other],allPadsAfter:[other],routes:[route],zones:[]}).staleIds).toEqual([]);
});
