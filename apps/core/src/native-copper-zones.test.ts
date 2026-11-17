import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createZone } from "@fp-pcb/client";
import { BoardLayer, PolyLineNodeSchema, ZoneFilledPolygonsSchema } from "@fp-pcb/proto";
import { copperZones } from "./fp-pcb-design";
import { analyzeStaleCopper, type CopperPolygon, type CopperRoute } from "./stale-copper";
const F = BoardLayer.BL_F_Cu, B = BoardLayer.BL_B_Cu, mm = 1e6;
const rectangle = (left: number, right: number) => ({ outline: [{x:left*mm,y:-mm},{x:right*mm,y:-mm},{x:right*mm,y:mm},{x:left*mm,y:mm}] });
const zone = () => createZone({ kind: "copper", layers: [F,B], net: {name:"A"}, polygons:[rectangle(4,6)] });
const routes: CopperRoute[] = [{id:"via",kind:"via",net:"A",layers:[F,B],path:[{x:5*mm,y:0}],width:.8*mm,locked:false}];
for (const stale of [false,true]) test(`native placement uses outlines with ${stale ? "stale" : "missing"} fills`, () => {
  const z = zone();
  if (stale) {
    const old = createZone({kind:"copper",layers:[F],polygons:[rectangle(8,9)]});
    z.proto.filledPolygons = [create(ZoneFilledPolygonsSchema,{layer:F,shapes:old.outline!})];
    z.proto.filled = true;
  }
  const zones = copperZones([z]);
  const pad = {id:"moving",parent:"J1",reference:"J1",number:"1",net:"A",shapes:[{layer:F,polygon:rectangle(4,6)}]};
  expect(analyzeStaleCopper({beforePads:[pad],afterPads:[{...pad,shapes:[]}],allPadsBefore:[pad],allPadsAfter:[],routes,zones}).staleIds).toEqual([]);
  expect(zones.every(z=>z.net==="A")).toBe(true);
});
test("native fallback subtracts copper keepouts but allows track-only rule areas", () => {
  const keepout = createZone({kind:"keepout",layers:[F,B],polygons:[rectangle(3,7)]});
  expect(copperZones([zone(),keepout]).flatMap(z=>z.polygons)).toHaveLength(0);
  keepout.proto.settings.case === "ruleAreaSettings" && (keepout.proto.settings.value.keepoutCopper = false);
  expect(copperZones([zone(),keepout]).flatMap(z=>z.polygons)).toHaveLength(2);
});

function semicircle() {
  const R = 100*mm;
  const z = createZone({kind:"copper",layers:[F],net:{name:"A"},polygons:[rectangle(0,100)]});
  z.proto.outline!.polygons[0]!.outline!.nodes = [create(PolyLineNodeSchema,{geometry:{case:"arc",value:{
    start:{xNm:0n,yNm:BigInt(-R)},mid:{xNm:BigInt(R),yNm:0n},end:{xNm:0n,yNm:BigInt(R)},
  }}})];
  return z;
}
test("remote keepout cannot discard curved zone padding or its touching via", () => {
  const z = semicircle();
  const remote = createZone({kind:"keepout",layers:[F],polygons:[rectangle(-20,-10)]});
  const angle = Math.PI/360;
  const at = {x:(100*mm+99000)*Math.cos(angle),y:(100*mm+99000)*Math.sin(angle)};
  const route: CopperRoute = {id:"via",kind:"via",net:"A",layers:[F],path:[at],width:.2*mm,locked:false};
  const pad = {id:"moving",parent:"J1",reference:"J1",number:"1",net:"A",shapes:[{layer:F,polygon:{outline:[
    {x:at.x-mm,y:at.y-mm},{x:at.x+mm,y:at.y-mm},{x:at.x+mm,y:at.y+mm},{x:at.x-mm,y:at.y+mm},
  ]}}]};
  for (const zs of [[z],[z,remote]]) expect(analyzeStaleCopper({beforePads:[pad],afterPads:[{...pad,shapes:[]}],
    allPadsBefore:[pad],allPadsAfter:[],routes:[route],zones:copperZones(zs)}).staleIds).toEqual([]);
});
test("curved keepout and hole uncertainty cannot shrink a zone outer bound", async () => {
  const { copperShapesTouch, subtractCopperKeepouts } = await import("@fabdesk/board-workflow/copper-contact");
  const curved = copperZones([semicircle()])[0]!.polygons[0]!;
  const square = {outline:[{x:-110*mm,y:-110*mm},{x:110*mm,y:-110*mm},{x:110*mm,y:110*mm},{x:-110*mm,y:110*mm}]};
  // At half a tessellation step: an exact boundary point and points just outside
  // the true exclusion, for both an outline and a hole.
  const a = Math.PI/360;
  const cases: Array<[CopperPolygon, CopperPolygon[], number]> = [
    [curved,[rectangle(-20,-10)],100*mm],
    [square,[curved],100*mm+1],
    // A concave exclusion boundary: this point is inside the true circular hole
    // but outside its chord hole. Raw-ring subtraction would wrongly remove it.
    [square,[{...square,holes:[curved.outline],padding:curved.padding!}],100*mm-1],
    [{...square,holes:[curved.outline],padding:curved.padding!},[rectangle(-20,-10)],100*mm+1],
  ];
  for (const [polygon, exclusions, radius] of cases) {
    const point = {path:[{x:radius*Math.cos(a),y:radius*Math.sin(a)}],width:.0001};
    expect(subtractCopperKeepouts(polygon,[...exclusions]).some(polygon => copperShapesTouch({polygon},[F],point,[F],F))).toBe(true);
  }
});
