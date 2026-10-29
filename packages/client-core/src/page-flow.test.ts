import { expect, test } from "bun:test";
import type { ProjectBoardSources } from "@fabdesk/protocol";
import { diffPreviewSvg } from "./diff-preview";
import { boardFileDestination } from "./board-file-destination";

test("diff display removes only the known generated legend and preserves all geometry and coordinates", () => {
  const shape = '<g data-ref="R1"><rect x="10" y="20" width="2" height="2"/><text>R1</text></g>';
  const svg = `<svg viewBox="0 0 30 40" data-board-diff="pcb">${shape}<text x="0" y="1">PCB · green added · red removed · amber moved/changed</text></svg>`;
  expect(diffPreviewSvg(svg)).toBe(`<svg viewBox="0 0 30 40" data-board-diff="pcb">${shape}</svg>`);
  expect(diffPreviewSvg(svg.replace(' data-board-diff="pcb"', ""))).toContain("green added");
  expect(diffPreviewSvg('<svg data-board-diff="pcb"><text>PCB · custom annotation</text></svg>')).toContain("custom annotation");
});
const data: ProjectBoardSources = {projectId:"project",mode:"assembly",manifestSha256:"a".repeat(64),observedAt:"2026-10-29T00:00:00.000Z",editing:"explicit-source-tools",assembly:{contract:"fabplane.assembly.v1",sources:[{id:"io",name:"I/O",location:"project",directory:"boards/io"}],instances:[{id:"left",sourceId:"io",name:"Left"}],connections:[]},sources:[{source:{id:"io",name:"I/O",location:"project",directory:"boards/io"},status:"available",pcbPath:"boards/io/board.kicad_pcb",schematicPath:"boards/io/board.kicad_sch"}]};
test("native file navigation captures the exact member source and rejects historical or unavailable files", () => {
  expect(boardFileDestination(data,"boards/io/board.kicad_pcb")?.selection).toMatchObject({projectId:"project",sourceId:"io",instanceId:"left",manifestSha256:data.manifestSha256});
  expect(boardFileDestination(data,"boards/io/board.kicad_sch")?.tab).toBe("schematic");
  expect(boardFileDestination(data,"archive/board.kicad_pcb")).toBeNull();
  expect(boardFileDestination({...data,sources:[{...data.sources[0]!,status:"blocked"}]},"boards/io/board.kicad_pcb")).toBeNull();
});
test("single-board source shortcuts accept canonical design files only", () => {
  const single: ProjectBoardSources={...data,mode:"single",sources:[],assembly:null,manifestSha256:null};
  expect(boardFileDestination(single,"board.kicad_pcb")).toEqual({tab:"pcb",selection:null});
  expect(boardFileDestination(single,"board.kicad_sch")?.tab).toBe("schematic");
  expect(boardFileDestination(single,"backup/board.kicad_pcb")).toBeNull();
  expect(boardFileDestination(single,"renders/top.png")).toBeNull();
});
