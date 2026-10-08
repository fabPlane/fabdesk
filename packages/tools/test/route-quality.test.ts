import {test,expect} from "bun:test";
import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {createRegistry} from "../src";
import {mockServices,contextFactory,tempProject} from "./mock-services";

test("route_run carries explicit rules and retains capability outcomes with saved-board facts",async()=>{
 const project=await tempProject("quality-plumbing");
 const pcb='(kicad_pcb (net "D_P") (net "D_N"))';await writeFile(join(project.dir,"board.kicad_pcb"),pcb);await writeFile(join(project.dir,"board.kicad_pro"),'{}');
 const base=mockServices([project]);let received:any;
 const pairRouting={capability:"measurement-only" as const,pairs:[{p:"D_P",n:"D_N",status:"independent-fallback" as const,reason:"members routed independently"}]};
 const services=mockServices([project],{design:{...base.design,route:async(dir,options)=>{received=options;await writeFile(join(dir,"board.kicad_pcb"),'(kicad_pcb (net "D_P") (net "D_N") (segment (start 0 0) (end 1 0) (width 0.15) (layer "F.Cu") (net "D_P") (uuid "a")) (segment (start 0 1) (end 1 1) (width 0.15) (layer "F.Cu") (net "D_N") (uuid "b")))');return {tracks:2,vias:0,claimedVias:0,routed:2,total:2,trackLengthNm:2000000,elapsedMs:1,wallMs:1,timedOut:false,message:"route",unrouted:[],log:[],pairRouting};}}});
 const registry=createRegistry(),factory=contextFactory(services,project);
 const call=(name:string,args:any)=>registry.invoke(name,args,ref=>factory({def:registry.get(name)!,projectRef:ref,signal:new AbortController().signal,progress:()=>{}}));
 const pairs=[{p:"D_P",n:"D_N",widthMm:0.15,gapMm:0.25}],perNet=[{net:"D_P",widthMm:0.15}];
 const response=await call("route_run",{router:"fab_router",waitMs:1000,rules:{pairs,perNet}});const data=response.json as any;
 const id=data.run?.id??data.runId;const run=services.routeRuns.get(id)!;expect(run.state).toBe("completed");expect(received.settings).toMatchObject({differentialPairs:pairs,perNet});
 const detail=JSON.parse(await readFile(join(project.dir,run.result!.quality!.detailPath),"utf8"));expect(detail.pairRouting).toEqual(pairRouting);expect(detail.pairs[0]).toMatchObject({lengthPMm:1,lengthNMm:1,skewMm:0});
 expect(run.result?.quality?.text).toContain("measurement-only");expect(Buffer.byteLength(run.result!.quality!.text)).toBeLessThanOrEqual(1800);
 expect((await call("route_status",{runId:id})).text).toContain("independent-fallback");
 await expect(call("route_run",{rules:{perNet:[{net:"missing",widthMm:0.3}]}})).rejects.toThrow("missing");
});
