import { expect, test } from "bun:test";
import { createRegistry, type NativeSchematicSnapshot } from "../src";
import { mockServices, tempProject, contextFactory } from "./mock-services";
async function fixture(symbolCount = 1) {
  const project = await tempProject("schematic-counts");
  await Bun.write(`${project.dir}/board.kicad_sch`, "(kicad_sch)");
  const base = mockServices([project]);
  const snapshot: NativeSchematicSnapshot = {
    revision: 2,
    pcbRevision: 0,
    symbols: Array.from({ length: symbolCount }, (_, i) => ({
      id: `s${i}`,
      reference: `R${i + 1}`,
      value: "1k",
      libId: "Device:R",
      footprint: "",
      position: { x: 10, y: 10 },
      rotation: 0,
      mirrorX: false,
      mirrorY: false,
      pins: [
        { id: `p${i}a`, number: "1", name: "", position: { x: 10, y: 5 } },
        { id: `p${i}b`, number: "2", name: "", position: { x: 10, y: 15 } },
      ],
    })),
    wires: [{ id: "w", start: { x: 10, y: 5 }, end: { x: 20, y: 5 } }],
    localLabels: [{ id: "l", text: "A", position: { x: 20, y: 5 } }],
    globalLabels: [],
    junctions: [{ id: "j", position: { x: 20, y: 5 } }],
    noConnects: [],
    texts: [],
    nets: [
      { name: "/A", itemCount: 3, itemIds: ["p0a", "w", "l"] },
      { name: "/B", itemCount: 1, itemIds: ["p0b"] },
    ],
    erc: { errors: 0, warnings: 0 },
  };
  const services = mockServices([project], {
      design: { ...base.design, schematicInspect: async () => snapshot },
    }),
    factory = contextFactory(services, project),
    reg = createRegistry();
  return (params: Record<string, unknown>) =>
    reg.invoke("schematic_inspect", params, () =>
      factory({
        def: reg.get("schematic_inspect")!,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
}
test("compact authoring preserves full sheet counts while omitting wire arrays", async () => {
  const call = await fixture();
  const result = await call({ detail: "authoring" });
  const data: any = result.json;
  expect(data.counts).toMatchObject({
    symbols: 1,
    wires: 1,
    localLabels: 1,
    junctions: 1,
    projectNets: 2,
  });
  expect(data.wires).toBeUndefined();
  expect(result.text).toContain("1 wires, 1 local labels");
  const selected: any = (await call({ netNames: ["/A"] })).json;
  expect(selected.counts.projectNets).toBe(2);
  expect(selected.nets).toHaveLength(1);
});
test("untargeted full and authoring keep every pin beyond 1000 objects; explicit limits remain bounded", async () => {
  const call = await fixture(600);
  for (const detail of ["full", "authoring"]) {
    const data: any = (await call({ detail })).json;
    expect(data.symbols).toHaveLength(600);
    expect(data.symbols.every((s: any) => s.pins.length === 2)).toBe(true);
    expect(data.selection.truncated).toBe(false);
    expect(data.selection.limit).toBeNull();
  }
  const bounded: any = (await call({ detail: "full", limit: 10 })).json;
  expect(bounded.selection.returned).toBe(10);
  expect(bounded.selection.truncated).toBe(true);
  expect(bounded.counts.symbols).toBe(600);
});
