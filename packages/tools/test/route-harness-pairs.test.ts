import { test,expect } from "bun:test";
import { writeFile,readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { projectPairs,copperBoard } from "../src/routing-quality";
import { contextFactory,mockServices,tempProject } from "./mock-services";
const seg=(net:string,length:number)=>`(segment (start 0 0) (end ${length} 0) (width 0.3) (layer "F.Cu") (net "${net}") (uuid "${net}"))`;
const pcb=(length:number)=>`(kicad_pcb (net "D_P") (net "D_N") (net "OTHER") ${seg("D_P",length)} ${seg("D_N",1)} ${seg("OTHER",1)})`;
for(const better of [true,false]) test(`pair-only attempt is kept only when skew improves: ${better}`,async()=>{
 const project=await tempProject(`pair-${better}`);await writeFile(join(project.dir,"board.kicad_pcb"),pcb(1));
 await writeFile(join(project.dir,"board.kicad_pro"),JSON.stringify({net_settings:{classes:[{name:"Default",diff_pair_width:0.3,diff_pair_gap:0.2}]}}));
 const definitions=await projectPairs(project.dir,copperBoard(pcb(1)));expect(definitions).toEqual([{p:"D_P",n:"D_N",source:"native netclass",widthMm:0.3,gapMm:0.2}]);
 const base=mockServices([project]);let calls=0;const scopes:string[][]=[];let pairOptions:any;
 const services=mockServices([project],{design:{...base.design,
 query:async(dir,select)=>select==="unrouted"?[]:base.design.query(dir,select),
 unroute:async(_dir,nets)=>{scopes.push(nets!);return{tracks:2,vias:0};},
 route:async(dir,options)=>{calls++;if(calls===2)pairOptions=options;await writeFile(join(dir,"board.kicad_pcb"),pcb(calls===2?(better?1:4):3));return{tracks:2,vias:0,claimedVias:0,routed:2,total:2,trackLengthNm:4e6,elapsedMs:1,wallMs:1,timedOut:false,message:"route",unrouted:[],log:[]};}
 }});
 const registry=createRegistry(),factory=contextFactory(services,project);
 const response=await registry.invoke("route_run",{router:"fab_router",waitMs:1000},ref=>factory({def:registry.get("route_run")!,projectRef:ref,signal:new AbortController().signal,progress:()=>{}}));
 const run=services.routeRuns.get((response.json as any).run.id)!;
 expect(calls).toBe(2);expect(scopes).toEqual([["D_P","D_N"]]);expect(pairOptions.nets).toEqual(["D_P","D_N"]);
 expect(pairOptions.settings.differentialPairs).toEqual([{p:"D_P",n:"D_N",widthMm:0.3,gapMm:0.2}]);
 expect(run.application.state).toBe(better?"applied":"manual");expect(await readFile(join(project.dir,"board.kicad_pcb"),"utf8")).toBe(pcb(1));
 const trials=JSON.parse(await readFile(join(project.dir,run.artifacts.runDir,"pair-attempts.json"),"utf8"));expect(trials[0].selected).toBe(better);
});
