import { test, expect } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { solidKernel } from "@fabdesk/kicad/enclosure-solid";
import { measureGlb } from "@fabdesk/kicad";
import { extractBoardFeatures } from "@fabdesk/kicad/board-features";
import { isPlanarBoardLayer } from "../src/tools/enclosure-detailed-fit";
import { defaultEnclosureDesign } from "../../client-core/src/enclosure-design";
import { createRegistry, makeContext } from "../src";
import { tempProject, mockServices } from "./mock-services";

async function cubeGlb(width: number) {
  const k = await solidKernel(),
    cube = k.Manifold.cube([width, 20, 1.6]);
  const m = cube.getMesh();
  cube.delete();
  const positions = new Float32Array(m.vertProperties.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = m.vertProperties[i]! / 1000;
    positions[i + 1] = m.vertProperties[i + 2]! / 1000;
    positions[i + 2] = m.vertProperties[i + 1]! / 1000;
  }
  const indices = new Uint32Array(m.triVerts);
  for (let i = 0; i < indices.length; i += 3) {
    const v = indices[i + 1]!;
    indices[i + 1] = indices[i + 2]!;
    indices[i + 2] = v;
  }
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "board", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: positions.length / 3, type: "VEC3" },
      { bufferView: 1, componentType: 5125, count: indices.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength },
      { buffer: 0, byteOffset: positions.byteLength, byteLength: indices.byteLength },
    ],
    buffers: [{ byteLength: positions.byteLength + indices.byteLength }],
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += " ";
  const j = new TextEncoder().encode(text),
    bin = new Uint8Array(positions.byteLength + indices.byteLength);
  bin.set(new Uint8Array(positions.buffer));
  bin.set(new Uint8Array(indices.buffer), positions.byteLength);
  const out = new Uint8Array(28 + j.length + bin.length),
    v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, j.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  v.setUint32(20 + j.length, bin.length, true);
  v.setUint32(24 + j.length, 0x004e4942, true);
  out.set(bin, 28 + j.length);
  return out;
}
test("planar layer classification never hides a component or raised surface", () => {
  const board = {
    placement: { path: "board.kicad_pcb", x: 0, y: 0, z: 0, rotation: 0 },
    features: extractBoardFeatures(
      '(kicad_pcb (general(thickness 1.6))(gr_rect(start 0 0)(end 40 20)(layer "Edge.Cuts")))',
    ),
  };
  const layer = {
    name: "anonymous-layer",
    vertices: 6,
    origin: { x: 0, y: 0, z: 0 },
    bounds: { minX: 0, minY: 0, minZ: 1.585, maxX: 40, maxY: 20, maxZ: 1.585 },
  };
  expect(isPlanarBoardLayer(layer, board, new Set(["J1"]))).toBe(true);
  expect(isPlanarBoardLayer({ ...layer, name: "J1" }, board, new Set(["J1"]))).toBe(false);
  expect(
    isPlanarBoardLayer(
      { ...layer, bounds: { ...layer.bounds, minZ: 8, maxZ: 8 } },
      board,
      new Set(),
    ),
  ).toBe(false);
  expect(
    isPlanarBoardLayer({ ...layer, bounds: { ...layer.bounds, maxZ: 1.7 } }, board, new Set()),
  ).toBe(false);
  expect(
    isPlanarBoardLayer({ ...layer, bounds: { ...layer.bounds, maxX: 50 } }, board, new Set()),
  ).toBe(false);
});
test("detailed fit catches actual geometry beyond the estimated outline and blocks exports", async () => {
  const project = await tempProject("detailed"),
    services = mockServices([project]);
  const source =
    '(kicad_pcb (general(thickness 1.6))(gr_rect(start 0 0)(end 40 20)(layer "Edge.Cuts")))';
  await writeFile(join(project.dir, "board.kicad_pcb"), source);
  let width = 40;
  services.kicad.resolveCli = async () => ({ path: "fixture-cli", version: "test" });
  services.kicad.exportGlb = async (_cli, opts) => {
    await writeFile(opts.output, await cubeGlb(width));
    return { fused: true, warnings: [] };
  };
  const d = defaultEnclosureDesign(null);
  d.confirmed = true;
  d.detailedFit = true;
  d.space = {
    x: -2,
    y: -2,
    width: 44,
    depth: 24,
    height: 20,
    wall: 2,
    floor: 2,
    lid: 2,
    clearance: 1,
  };
  d.boards = [{ path: "board.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 }];
  const registry = createRegistry(),
    invoke = (args: Record<string, unknown>) =>
      registry.invoke("cad_fit", { project: project.id, design: d, ...args }, () =>
        makeContext({ services, project }),
      );
  const clear = (await invoke({ action: "preview" })).json as any;
  expect(clear.report.issues.some((i: any) => i.code === "detailed-collision")).toBe(false);
  expect(
    clear.report.issues.some(
      (i: any) => i.code === "detailed-coverage" && i.message.includes("1 closed"),
    ),
  ).toBe(true);
  width = 41.5;
  d.obstacles = [{ name: "Cable reserve", x: 42, y: 2, z: 5, width: 2, depth: 2, height: 2 }];
  const near = (await invoke({ action: "preview" })).json as any;
  expect(near.report.issues.some((i: any) => i.code === "detailed-clearance")).toBe(true);
  d.obstacles = [];
  width = 45;
  const blocked = (await invoke({ action: "preview" })).json as any;
  expect(blocked.report.status).toBe("blocked");
  expect(blocked.report.issues.some((i: any) => i.code === "detailed-collision")).toBe(true);
  expect(
    blocked.report.issues.find((i: any) => i.code === "detailed-collision").regions[0].width,
  ).toBeGreaterThan(0);
  await expect(invoke({ action: "build", expectedRevision: blocked.revision })).rejects.toThrow(
    "actual 3D geometry",
  );
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(source);
  services.kicad.exportGlb = async (_cli, opts) => {
    await writeFile(opts.output, "invalid GLB");
    return { fused: false, warnings: [] };
  };
  const incomplete = (await invoke({ action: "preview" })).json as any;
  expect(incomplete.report.issues.some((i: any) => i.code === "detailed-unavailable")).toBe(true);
  expect(
    incomplete.report.issues.some(
      (i: any) => i.code === "detailed-coverage" && i.message.includes("0 closed"),
    ),
  ).toBe(true);
});
test("GLB triangle capture keeps mm coordinates and repairs the axis-conversion winding", async () => {
  const bytes = await cubeGlb(40),
    plain = measureGlb(bytes),
    full = measureGlb(bytes, { triangles: true });
  expect(plain.roots[0]!.triangles).toBeUndefined();
  expect(full.roots[0]!.triangles).toHaveLength(108);
  expect(full.roots[0]!.bounds!.maxX).toBeCloseTo(40);
  const { solidFromTriangles } = await import("@fabdesk/kicad/enclosure-solid");
  const k = await solidKernel(),
    s = solidFromTriangles(k, full.roots[0]!.triangles!);
  try {
    expect(s.volume()).toBeCloseTo(40 * 20 * 1.6, 2);
  } finally {
    s.delete();
  }
});
