import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createFpPcbDesign } from "./fp-pcb-design";
import { FpPcbBridgeClient } from "./fp-pcb-bridge";
import { FpPcbSessions } from "./fp-pcb-session";
const url=process.env["FABDESK_FP_PCB_TEST_URL"], workspace=process.env["FABDESK_FP_PCB_TEST_WORKSPACE"];
for (const [libId,units] of [["Amplifier_Operational:LM358",3],["Amplifier_Operational:LM324",5],["Comparator:LM393",3],["74xx:74HC00",5],["Timer:NE556",2]] as const) {
 test.skipIf(!url||!workspace)(`native distinct units, metadata guards and selected-unit updates: ${libId}`,async()=>{
  const dir=await mkdtemp(join(workspace!,"multiunit-contract-"));
  const bridge=new FpPcbBridgeClient({url:url!}),sessions=new FpPcbSessions(()=>bridge),design=createFpPcbDesign({bridge:()=>bridge,sessions});
  const symbol=(unit:number,value="part")=>({libId,reference:"U1",value,unit,footprint:"Package_DIP:DIP-14_W7.62mm",position:{x:50.8+unit*50.8,y:50.8}});
  try {
   await design.schematicEdit(dir,{symbols:Array.from({length:units},(_,i)=>symbol(i+1))});
   const snapshot=await design.schematicInspect(dir);
   expect(snapshot.symbols.map(s=>s.unit).sort()).toEqual(Array.from({length:units},(_,i)=>i+1));
   const path=join(dir,"board.kicad_sch"),before=await readFile(path);
   await expect(design.schematicEdit(dir,{symbols:[symbol(1)]})).rejects.toThrow("unit 1");
   await expect(design.schematicEdit(dir,{symbols:[{...symbol(units+1),reference:"U2"}]})).rejects.toThrow("has units");
   await expect(design.schematicEdit(dir,{symbolUpdates:[{reference:"U1",position:{x:25.4,y:25.4}}]})).rejects.toThrow("specify unit");
   expect(await readFile(path)).toEqual(before);
   await design.schematicEdit(dir,{symbolUpdates:[{reference:"U1",unit:1,position:{x:25.4,y:25.4}}]});
   const moved=await design.schematicInspect(dir);
   expect(moved.symbols.find(s=>s.unit===1)?.position).toEqual({x:25.4,y:25.4});
   for (const beforeSymbol of snapshot.symbols.filter(s=>s.unit!==1))
    expect(moved.symbols.find(s=>s.unit===beforeSymbol.unit)?.position).toEqual(beforeSymbol.position);
   // Replacement is one transaction; another part cannot take a remaining unit's reference.
   const id=moved.symbols.find(s=>s.unit===1)!.id;
   await expect(design.schematicEdit(dir,{deleteItemIds:[id],symbols:[symbol(1,"different part value")]})).rejects.toThrow("same libId, value and footprint");
   await design.schematicEdit(dir,{deleteItemIds:[id],symbols:[symbol(1)]});
   expect((await design.schematicInspect(dir)).symbols.length).toBe(units);
  } finally {await sessions.dispose();await rm(dir,{recursive:true,force:true});}
 },120000);
}
