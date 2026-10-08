import {test,expect} from "bun:test";
import {writeFile,readFile} from "node:fs/promises";
import {join} from "node:path";
import {createRegistry} from "../src";
import {mockServices,contextFactory,tempProject} from "./mock-services";
import { FpPcbRouteSummary } from "@fabdesk/protocol";

test("Freerouting collisions survive summary parsing, run/status text and saved result", async () => {
 const project = await tempProject("freerouting-endpoint-collisions");
 await writeFile(join(project.dir,"board.kicad_pcb"), '(kicad_pcb (net "GND"))');
 await writeFile(join(project.dir,"board.kicad_pro"), "{}");
 const endpointCollisions = {
   text: "Endpoint-track-width probe tested against the board before routing: 1 collision established. This does not establish that every escape is blocked.",
   obstacleSet: "pre-route" as const, testedEndpoints: 2, unsupported: 0, total: 1, truncated: false, physicalBlockerEstablished: true,
   collisions: [{ endpoint: { uuid: "pad-native", ref: "J1", pin: "1", layer: "F.Cu" }, blocker: { uuid: "via-native", type: "via" as const, net: "VBUS" }, requiredClearanceMm: 0.2, measuredClearanceMm: 0.1, test: "endpoint-track-width" as const }],
 };
 const summary = FpPcbRouteSummary.parse({ endpointCollisions, futureField: "stripped", total: 1, unrouted: [{net:"GND",from:{x:0,y:0},to:{x:1,y:1}}] });
 expect(summary.endpointCollisions).toEqual(endpointCollisions);
 expect(Object.hasOwn(summary,"futureField")).toBe(false);
 const base = mockServices([project]);
 const services = mockServices([project], { design: { ...base.design, query: async (dir,q) => q === "unrouted" ? [{net:"GND"}] : base.design.query(dir,q), route: async () => summary } });
 const registry=createRegistry(), factory=contextFactory(services,project);
 const call=(name:string,args:Record<string,unknown>)=>registry.invoke(name,args,ref=>factory({def:registry.get(name)!,projectRef:ref,signal:new AbortController().signal,progress:()=>{}}));
 const response = await call("route_run", { router: "freerouting", onlyConnections: ["GND"], waitMs: 1000 });
 const run = (response.json as any).run;
 const status = await call("route_status", { runId: run.id });
 const saved = JSON.parse(await readFile(join(project.dir,run.artifacts.runDir,"result.json"),"utf8"));
 expect(saved.endpointCollisions).toEqual(endpointCollisions);
 expect((status.json as any).run.result.endpointCollisions).toEqual(endpointCollisions);
 expect(response.text).toContain(endpointCollisions.text);
 expect(status.text).toContain(endpointCollisions.text);
});

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
