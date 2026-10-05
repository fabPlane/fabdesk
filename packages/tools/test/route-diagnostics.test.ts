import {test,expect} from "bun:test";
import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {createRegistry} from "../src";
import {mockServices,contextFactory,tempProject} from "./mock-services";

test("route_run and route_status preserve no-progress diagnostics in text and saved JSON",async()=>{
 const project=await tempProject("honest-route-diagnostics");
 await writeFile(join(project.dir,"board.kicad_pcb"),'(kicad_pcb (net "GND"))');
 await writeFile(join(project.dir,"board.kicad_pro"),"{}");
 const diagnostics={text:"fab_router stopped after 4 passes (stagnant): solver opens 16 → 8; generated 15 tracks and 7 vias; discarded 15 tracks and 7 vias because their nets were incomplete. No physical blocker was established. Next: try Freerouting and check native opens.",passes:4,stoppedBy:"stagnant",solverOpens:{before:16,after:8},generated:{tracks:15,vias:7},discarded:{tracks:15,vias:7},remaining:{nets:7,opens:8,detail:[{net:"GND",incomplete:2}]},leftoverEndpoints:[],leftoverEndpointTotal:32,physicalBlockerEstablished:false,collisions:[]};
 const base=mockServices([project]);
 const services=mockServices([project],{design:{...base.design,query:async(dir,q)=>q==="unrouted"?[{net:"GND"}]:base.design.query(dir,q),route:async()=>({tracks:0,vias:0,claimedVias:0,routed:0,total:16,trackLengthNm:0,elapsedMs:1,wallMs:1,timedOut:false,message:diagnostics.text,unrouted:[{net:"GND",from:{x:0,y:0},to:{x:1,y:1}}],log:[diagnostics.text],diagnostics})}});
 const registry=createRegistry(),factory=contextFactory(services,project);
 const call=(name:string,args:Record<string,unknown>)=>registry.invoke(name,args,ref=>factory({def:registry.get(name)!,projectRef:ref,signal:new AbortController().signal,progress:()=>{}}));
 const response=await call("route_run",{router:"fab_router",onlyConnections:["GND"],waitMs:1000});
 const run=(response.json as any).run;
 const status=await call("route_status",{runId:run.id});
 const saved=JSON.parse(await readFile(join(project.dir,run.artifacts.runDir,"result.json"),"utf8"));
 expect(saved.state).toBe("no-progress");
 expect(saved.diagnostics).toEqual(diagnostics);
 expect((status.json as any).run.result.diagnostics).toEqual(diagnostics);
 expect(response.text).toContain(diagnostics.text);
 expect(status.text).toContain(diagnostics.text);
 expect(saved.changedGeometry).toEqual([]);
});
