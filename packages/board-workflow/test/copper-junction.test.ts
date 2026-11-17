import { expect, test } from "bun:test";
import { pruneDangling } from "../src/edit/prune";
import { fpT, seg } from "./edit-fixture";
import { buildCopperGraph, pruneCopperLeaves } from "../src/copper-graph";
const via = '(via (at 5 0) (size .8) (drill .4) (layers "F.Cu" "B.Cu") (net "A"))';
const front = fpT("U1",0,0,[["1","A",0,0]]) + seg(0,0,5,0,"A");
test("outline support anchors separate contacts without edges or junction unions", () => {
  const graph = buildCopperGraph([
    ...[0, 8].map(x => ({ id: `track:${x}`, net: "A", kind: "track" as const,
      copper: [{ layers: ["F.Cu"], shape: { path: [{ x, y: 0 }, { x: x + 2, y: 0 }], width: .2 } }] })),
    { id: "outline", net: "A", kind: "support", copper: [{ layers: ["F.Cu"], shape: { polygon: {
      outline: [{ x: -1, y: -1 }, { x: 11, y: -1 }, { x: 11, y: 1 }, { x: -1, y: 1 }],
    } } }] },
  ]);
  expect([...graph.edges.values()].every(edges => edges.size === 0)).toBe(true);
  expect(graph.ports.some(port => port.owner === "outline")).toBe(false);
  expect(graph.contacts).toEqual([]);
  expect([...pruneCopperLeaves(graph)]).toEqual([]);
});
for (const cache of ["missing", "unverified", "current"] as const) {
  test(`${cache} split fill preserves the sole endpoint-cap bridge`, () => {
    const land = (ref: string, y: number) => fpT(ref,5.53,y,[["1","A",0,0]])
      .replace('(size 0.6 0.6)', '(size 0.2 0.2)').replace('(layers "F.Cu" "F.Paste")', '(layers "B.Cu")');
    const polygon = '(polygon (pts (xy 5.35 -.4) (xy 5.9 -.4) (xy 5.9 .4) (xy 5.35 .4)))';
    const island = (a: number, b: number) => `(filled_polygon (layer "B.Cu") (pts (xy 5.42 ${a}) (xy 5.64 ${a}) (xy 5.64 ${b}) (xy 5.42 ${b})))`;
    const bridge = seg(5.48,0,10,0,"A","B.Cu");
    const text = `(kicad_pcb ${bridge} ${land("U2",.15)} ${land("U3",-.15)} (zone (net "A") (layer "B.Cu") ${polygon} ${cache === "missing" ? "" : island(.05,.25) + island(-.25,-.05)}))`;
    const result = pruneDangling(text,new Set(["A"]),cache === "current" ? { currentFillBoard: text } : undefined);
    expect(result.pruned).toBe(0);
    expect(result.text).toContain(bridge);
  });
}
test("endpoint cap is the sole bridge between separate terminals", () => {
  const land = (ref: string, y: number) => fpT(ref,5.53,y,[["1","A",0,0]])
    .replace('(size 0.6 0.6)', '(size 0.2 0.2)').replace('(layers "F.Cu" "F.Paste")', '(layers "B.Cu")');
  const text = `(kicad_pcb ${via} ${seg(5.48,0,10,0,"A","B.Cu")} ${land("U2",.15)} ${land("U3",-.15)})`;
  const r = pruneDangling(text,new Set(["A"]));
  expect(r.pruned).toBe(0);
  expect(r.text).toContain('(start 5.48 0)');
});
for (const stub of [seg(5,0,5.2,0,"A","B.Cu"), seg(5,0,5.14,0,"A","B.Cu") + seg(5.14,0,5.28,0,"A","B.Cu")]) {
  test("overlapping caps do not create independent exits", () => {
    const text = `(kicad_pcb ${front} ${via} ${stub})`;
    expect(pruneDangling(text,new Set(["A"])).pruned).toBe(stub.includes('5.28') ? 4 : 3);
  });
}
const outline = '(polygon (pts (xy 4 -1) (xy 6 -1) (xy 6 1) (xy 4 1)))';
const fill = '(filled_polygon (layer "F.Cu") (pts (xy 8 -1) (xy 9 -1) (xy 9 1) (xy 8 1)))';
const board = (extra: string) => `(kicad_pcb ${front} ${via} (zone (net "A") (layer "F.Cu") ${outline} ${extra}))`;
test("missing fill conservatively anchors the outline", () => {
  expect(pruneDangling(board(""),new Set(["A"])).pruned).toBe(0);
});
test("unverified old fill cannot override an outline", () => {
  expect(pruneDangling(board(fill),new Set(["A"])).pruned).toBe(0);
});
test("current refill with removed island does not anchor the outline", () => {
  const text = board(fill);
  expect(pruneDangling(text,new Set(["A"]), { currentFillBoard: text }).pruned).toBe(2);
  const changed = text.replace('(xy 6 1)', '(xy 7 1)');
  expect(pruneDangling(changed,new Set(["A"]), { currentFillBoard: text }).pruned).toBe(0);
});
test("keepout is never a fallback terminal", () => {
  expect(pruneDangling(board('(keepout (tracks not_allowed))'),new Set(["A"])).pruned).toBe(2);
});

test("a separate keepout cuts a hole in the conservative zone terminal", () => {
  const text = board("").replace(/\)$/, '(zone (layer "F.Cu") (keepout (copperpour not_allowed)) (polygon (pts (xy 3 -2) (xy 7 -2) (xy 7 2) (xy 3 2)))))');
  // The main track still touches solid pour at x=4 only inside the keepout.
  expect(pruneDangling(text,new Set(["A"])).pruned).toBe(2);
});
test("a real routing loop survives leaf pruning", () => {
  const text = `(kicad_pcb ${seg(0,0,5,0,"A")} ${seg(5,0,5,5,"A")} ${seg(5,5,0,5,"A")} ${seg(0,5,0,0,"A")})`;
  expect(pruneDangling(text,new Set(["A"])).pruned).toBe(0);
});

test("the replay's three one-terminal components all prune", async () => {
  const text = await Bun.file(new URL('./fixtures/replay-dangling-components.kicad_pcb', import.meta.url)).text();
  for (const [net, count] of [["USB_SP_DP",8],["USB_A2_DN",4],["USB_A2_DP",12]] as const) {
    const result = pruneDangling(text,new Set([net]));
    expect(result.pruned).toBe(count);
    expect(pruneDangling(result.text,new Set([net])).pruned).toBe(0);
  }
});
test("a rule area allowing pours does not cut the fallback terminal", () => {
  const text = board("").replace(/\)$/, '(zone (layer "F.Cu") (keepout (tracks not_allowed) (copperpour allowed)) (polygon (pts (xy 3 -2) (xy 7 -2) (xy 7 2) (xy 3 2)))))');
  expect(pruneDangling(text,new Set(["A"])).pruned).toBe(0);
});

test("an unsplit closed arc is a loop, not an absorbed short item", async () => {
  const { buildCopperGraph, pruneCopperLeaves } = await import('../src/copper-graph');
  const graph = buildCopperGraph([{id:"loop",kind:"arc",net:"A",copper:[{layers:["F.Cu"],shape:{width:.2,path:[{x:0,y:0},{x:5,y:0},{x:5,y:5},{x:0,y:5},{x:0,y:0}]}}]}]);
  expect([...pruneCopperLeaves(graph)]).toEqual([]);
});

for (const alternate of ["none", "rect", "custom", "via", "drilled-pad", "zone"] as const) {
  test(`${alternate} alternate envelope cannot replace an endpoint-cap bridge`, () => {
    const land = (ref: string, y: number) => fpT(ref,5.53,y,[["1","A",0,0]])
      .replace('(size 0.6 0.6)', '(size 0.2 0.2)');
    const custom = land("U4",.6).replace('smd rect','smd custom').replace('(size 0.2 0.2)',
      '(size 0.2 0.2) (options (clearance outline) (anchor rect)) (primitives (gr_poly (pts (xy -.1 -.1) (xy .1 -.1) (xy .1 .1) (xy -.1 .1)) (width 0) (fill yes)))');
    const extra = alternate === "custom" ? custom : alternate === "rect" ? land("U4",.6) :
      alternate === "via" ? '(via (at 5.53 0) (size 1) (drill .8) (layers "F.Cu" "B.Cu") (net "A"))' :
      alternate === "drilled-pad" ? land("U4",0).replace('smd rect','thru_hole circle')
        .replace('(size 0.2 0.2)', '(size 1 1) (drill .8)') :
      alternate === "zone" ? '(zone (net "A") (layer "F.Cu") (polygon (pts (xy 5 -.4) (xy 6 -.4) (xy 6 .4) (xy 5 .4))))' : '';
    const bridge = seg(5.53,0,10,0,"A");
    const text = `(kicad_pcb ${bridge} (via (at 10 0) (size .8) (drill .4) (layers "F.Cu" "B.Cu") (net "A")) ${land("U2",.15)} ${land("U3",-.15)} ${extra})`;
    const result = pruneDangling(text,new Set(["A"]));
    expect(result.text).toContain(bridge);
    expect(result.pruned).toBe(1);
  });
}

test("inflated arc chords cannot replace the cap bridge after its tail via prunes", () => {
  const land = (ref: string, y: number) => fpT(ref,99.99995,y,[["1","A",0,0]])
    .replace('(size 0.6 0.6)', '(size 0.000002 0.2)');
  const bridge = seg(99.99995,0,110,0,"A").replace('(width 0.2)', '(width 2.5)');
  // The actual radius-100 arc never reaches either narrow pad (|y| >= 1.15).
  // Its deliberately conservative chord envelope does reach both.
  const arc = '(arc (start 0 -100) (mid 100 0) (end 0 100) (width .000001) (layer "F.Cu") (net "A"))';
  const text = `(kicad_pcb ${bridge} (via (at 110 0) (size .8) (drill .4) (layers "F.Cu" "B.Cu") (net "A")) ${land("U2",1.25)} ${land("U3",-1.25)} ${arc})`;
  const result = pruneDangling(text,new Set(["A"]));
  expect(result.text).toContain(bridge);
  expect(result.pruned).toBe(1);
});

test("terminal proof cannot forget remote terminals behind uncertain contacts", () => {
  const copper = (x: number, y: number, inner?: null) => [{ layers: ["F.Cu"], shape: { path: [{x,y}], width: .2, ...(inner === null ? {inner} : {}) } }];
  const graph = buildCopperGraph([
    { id: "bridge", net: "A", kind: "track", copper: [{ layers: ["F.Cu"], shape: { path: [{x:0,y:0},{x:5,y:0}], width:.2 } }] },
    ...[-.15,.15].flatMap((y, i) => [
      { id: `unknown:${i}`, net: "A", kind: "via" as const, copper: copper(0,y,null) },
      { id: `terminal:${i}`, net: "A", kind: "pad" as const, copper: copper(0,2*y) },
    ]),
  ]);
  expect(pruneCopperLeaves(graph).has("bridge")).toBe(false);
});

test("contact bounds separate growth, unknown geometry, holes and exact contacts", async () => {
  const { copperContact } = await import("../src/copper-contact");
  const layers = ["F.Cu"];
  const a = {path:[{x:0,y:0}],width:1,exact:"circle-pad" as const};
  const b = {path:[{x:1.01,y:0}],width:1,exact:"circle-pad" as const};
  expect(copperContact(a,layers,b,layers,"F.Cu",.02)).toEqual({mayTouch:true,surelyTouches:false});
  expect(copperContact(a,layers,{...a,inner:null},layers,"F.Cu")).toEqual({mayTouch:true,surelyTouches:false});
  expect(copperContact({path:a.path,width:a.width},layers,a,layers,"F.Cu").surelyTouches).toBe(false);
  expect(copperContact(a,layers,a,layers,"F.Cu")).toEqual({mayTouch:true,surelyTouches:true});
  expect(copperContact(a,layers,a,layers,"B.Cu")).toEqual({mayTouch:false,surelyTouches:false});
  const ring = (r: number) => [{x:-r,y:-r},{x:r,y:-r},{x:r,y:r},{x:-r,y:r}];
  const polygon = {outline:ring(2),holes:[ring(.6)],padding:.2};
  expect(copperContact(a,layers,{polygon},layers,"F.Cu")).toEqual({mayTouch:true,surelyTouches:false});
  expect(copperContact(a,layers,{polygon:{...polygon,padding:0}},layers,"F.Cu")).toEqual({mayTouch:false,surelyTouches:false});
});

// Review 7: a chamfer removes the apparent alternate path through the envelope.
test("chamfered roundrect cannot replace the sole cap bridge", () => {
  const land = (ref: string, x: number, y: number) => fpT(ref,x,y,[["1","A",0,0]])
    .replace('(size 0.6 0.6)', '(size 0.2 0.2)');
  const bridge = seg(.9,0,5,0,"A");
  const chamfer = fpT("U4",0,.7,[["1","A",0,0]]).replace('smd rect','smd roundrect')
    .replace('(size 0.6 0.6)', '(size 2 2) (roundrect_rratio 0) (chamfer_ratio .5) (chamfer top_right)');
  const result = pruneDangling(`(kicad_pcb ${bridge} ${via} ${land("U2",.9,.15)} ${land("U3",.9,-.15)} ${chamfer})`,new Set(["A"]));
  expect(result.pruned).toBe(1);
  expect(result.text).toContain(bridge);
});

for (const kind of ["circle", "rect", "oval", "roundrect", "chamfered", "trapezoid", "custom", "future-pad"] as const) {
  test(`${kind} pad has an outer envelope and only allow-listed pads prove contacts`, async () => {
    const { padCopper } = await import("../src/edit/prune-copper");
    const { copperContact, copperShapesTouch } = await import("../src/copper-contact");
    const spelling = kind === "chamfered" ? "roundrect" : kind;
    const extras = kind === "custom" ? '(options (anchor rect)) (primitives (gr_poly (pts (xy 3 0) (xy 4 0) (xy 4 1) (xy 3 1)) (width 0) (fill yes)))' : kind === "chamfered" ? '(chamfer_ratio .5) (chamfer top_right)' : kind === "trapezoid" ? '(rect_delta .5 0)' : '';
    const text = fpT("U1",0,0,[["1","A",0,0]]).replace('smd rect',`smd ${spelling}`)
      .replace('(size 0.6 0.6)', `(size 2 2) (roundrect_rratio .25) ${extras}`);
    const shape = padCopper(`(kicad_pcb ${text})`,["F.Cu"])[0]!.shape;
    const exact = ["circle","rect","oval","roundrect"].includes(kind);
    expect(copperContact(shape,["F.Cu"],shape,["F.Cu"],"F.Cu").surelyTouches).toBe(exact);
    // Independent boundary witnesses of these KiCad lands (and their interior).
    const witnesses = kind === "circle" || kind === "oval" ? [[1,0],[0,1],[-1,0]] : kind === "roundrect" ? [[1,.5],[.5,1],[0,0]] :
      kind === "trapezoid" ? [[1,1.25],[-1,.75],[0,0]] : kind === "chamfered" ? [[-1,-.5],[-1,.5],[.5,-1]] :
      kind === "custom" ? [[0,0],[3,0],[4,1]] : kind === "future-pad" ? [[0,0]] : [[1,1],[-1,-1],[0,0]];
    for (const [x,y] of witnesses) expect(copperShapesTouch(shape,["F.Cu"],{path:[{x:x!,y:y!}],width:0},["F.Cu"],"F.Cu")).toBe(true);
  });
}


test("route and polygon outer bounds contain analytic copper witnesses", async () => {
  const { routeCopper, zoneCopper } = await import("../src/edit/prune-copper");
  const { parseSexpr } = await import("../src/sexpr");
  const { copperContact, copperShapesTouch } = await import("../src/copper-contact");
  const layers = ["F.Cu","B.Cu"];
  const arc = routeCopper(parseSexpr('(arc (start 0 -100) (mid 100 0) (end 0 100) (width .2) (layer "F.Cu"))'),layers).shape;
  const straight = routeCopper(parseSexpr(seg(0,0,5,0,"A")),layers).shape;
  const disk = routeCopper(parseSexpr(via),layers).shape;
  const outline = '(zone (net "A") (layer "F.Cu") (polygon (pts (xy 0 0) (xy 2 0) (xy 2 2) (xy 0 2))))';
  for (const current of [false,true]) {
    const shape = zoneCopper(`(kicad_pcb ${outline.replace('polygon',current ? 'filled_polygon' : 'polygon')})`,current)[0]!.shape;
    expect(copperContact(shape,layers,shape,layers,"F.Cu").surelyTouches).toBe(current);
    for (const x of [0,1,2]) for (const y of [0,1,2])
      expect(copperShapesTouch(shape,layers,{path:[{x,y}],width:0},layers,"F.Cu")).toBe(true);
  }
  for (let i=0;i<=360;i++) {
    const angle = -Math.PI/2 + i*Math.PI/360;
    // Test both stroke boundaries, between tessellation samples as well as on them.
    for (const radius of [99.900000001,100.099999999])
      expect(copperShapesTouch(arc,layers,{path:[{x:radius*Math.cos(angle),y:radius*Math.sin(angle)}],width:0},layers,"F.Cu")).toBe(true);
    const full = i*Math.PI/180;
    expect(copperShapesTouch(disk,layers,{path:[{x:5+.399999999*Math.cos(full),y:.399999999*Math.sin(full)}],width:0},layers,"F.Cu")).toBe(true);
  }
  for (const x of [0,2.5,5]) for (const y of [-.1,0,.1])
    expect(copperShapesTouch(straight,layers,{path:[{x,y}],width:0},layers,"F.Cu")).toBe(true);
  expect(copperContact(arc,layers,arc,layers,"F.Cu").surelyTouches).toBe(false);
  expect(copperContact(disk,layers,disk,layers,"F.Cu").surelyTouches).toBe(false);
  const unclassified = {path:[{x:0,y:0}],width:1,inner:{path:[{x:0,y:0}],width:.5}};
  expect(copperContact(unclassified,layers,unclassified,layers,"F.Cu").surelyTouches).toBe(false);
});
