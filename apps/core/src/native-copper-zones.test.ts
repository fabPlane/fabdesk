import { expect, test } from "bun:test";
import { create } from "@bufbuild/protobuf";
import { createZone } from "@fp-pcb/client";
import { BoardLayer, ZoneFilledPolygonsSchema } from "@fp-pcb/proto";
import { copperZones } from "./fp-pcb-design";
import { analyzeStaleCopper, type CopperRoute } from "./stale-copper";
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
