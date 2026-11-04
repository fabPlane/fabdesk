import { expect, test } from "bun:test";
import { Box3, Vector3 } from "three";
import { enclosureBoardPose, mechanicalItem } from "@fabdesk/client-core";
import { MechanicalScene } from "./MechanicalScene";
const encode = (text: string) => new TextEncoder().encode(text).buffer;
const triangle =
  "solid triangle\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 20 0 0\nvertex 0 10 0\nendloop\nendfacet\nendsolid triangle";
test("STL and OBJ import preserve millimetre geometry", async () => {
  for (const [path, text] of [
    ["case.stl", triangle],
    ["case.obj", "v 0 0 0\nv 20 0 0\nv 0 10 0\nf 1 2 3"],
  ]) {
    const model = await MechanicalScene.decode({
      item: mechanicalItem(path!),
      data: encode(text!),
    });
    expect(new Box3().setFromObject(model).getSize(new Vector3()).toArray()).toEqual([20, 10, 0]);
  }
});
test("empty or invalid model geometry is rejected", async () => {
  await expect(
    MechanicalScene.decode({ item: mechanicalItem("bad.obj"), data: encode("not a model") }),
  ).rejects.toThrow(/empty, invalid/);
});

test("centre-mounted placement preserves the board's exported world frame", async () => {
  const pose = enclosureBoardPose(
    { path: "board.kicad_pcb", x: 3, y: 4, z: 5, rotation: 90 },
    { minX: 0, minY: 0, maxX: 20, maxY: 10, widthMm: 20, heightMm: 10 },
  );
  const model = await MechanicalScene.decode({
    item: mechanicalItem("board.stl", "board"),
    data: encode(triangle),
    origin: pose.origin,
  });
  model.position.set(...pose.position);
  model.rotation.z = Math.PI / 2;
  const bounds = new Box3().setFromObject(model);
  bounds.min.toArray().forEach((n, i) => expect(n).toBeCloseTo([-7, 4, 5][i]!));
  bounds.max.toArray().forEach((n, i) => expect(n).toBeCloseTo([3, 24, 5][i]!));
});
test("board and enclosure share a centred PCB frame while imports pivot at their centre", async () => {
  const board = await MechanicalScene.decode({
    item: mechanicalItem("board.stl", "board"),
    data: encode(triangle),
    origin: [10, 5, 0],
  });
  const base = await MechanicalScene.decode({
    item: mechanicalItem("base.stl", "base"),
    data: encode(triangle),
    origin: [10, 5, 0],
  });
  const imported = await MechanicalScene.decode({
    item: mechanicalItem("part.stl"),
    data: encode(triangle),
  });
  for (const model of [board, base, imported]) {
    const bounds = new Box3().setFromObject(model);
    expect(bounds.min.toArray()).toEqual([-10, -5, 0]);
    expect(bounds.max.toArray()).toEqual([10, 5, 0]);
  }
});
function glb() {
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: "VEC3",
        min: [0, 0, 0],
        max: [0.02, 0.01, 0.03],
      },
    ],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36 }],
  };
  const raw = JSON.stringify(json),
    text = raw.padEnd(Math.ceil(raw.length / 4) * 4, " "),
    size = 12 + 8 + text.length + 8 + 36,
    buffer = new ArrayBuffer(size),
    v = new DataView(buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, size, true);
  v.setUint32(12, text.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(buffer, 20, text.length).set(new TextEncoder().encode(text));
  const offset = 20 + text.length;
  v.setUint32(offset, 36, true);
  v.setUint32(offset + 4, 0x004e4942, true);
  new Float32Array(buffer, offset + 8, 9).set([0, 0, 0, 0.02, 0, 0.03, 0, 0.01, 0]);
  return buffer;
}
test("GLB imports convert metres to mm and KiCad board coordinates match enclosure XY", async () => {
  const generic = await MechanicalScene.decode({ item: mechanicalItem("part.glb"), data: glb() });
  const board = await MechanicalScene.decode({
    item: mechanicalItem("renders/board.glb", "board"),
    data: glb(),
  });
  const g = new Box3().setFromObject(generic),
    b = new Box3().setFromObject(board);
  expect(g.min.y).toBeCloseTo(-15);
  expect(g.max.y).toBeCloseTo(15);
  expect(b.max.y).toBeCloseTo(30);
  expect(b.max.x).toBeCloseTo(20);
  expect(b.max.z).toBeCloseTo(10);
});

test("downloaded PCB STL preserves KiCad millimetres and board axes", async () => {
  const blob = await MechanicalScene.boardStl("board.glb", glb());
  const bytes = new DataView(await blob.arrayBuffer());
  // Normals must follow the mirrored coordinate transform, not turn inside out.
  expect(bytes.getFloat32(84, true)).toBeLessThan(0);
  expect(bytes.getFloat32(88, true)).toBeGreaterThan(0);
  const model = await MechanicalScene.decode({
    item: mechanicalItem("pcb.stl", "board"),
    data: await blob.arrayBuffer(),
    origin: [0, 0, 0],
  });
  const bounds = new Box3().setFromObject(model);
  expect(bounds.min.x).toBeCloseTo(0);
  expect(bounds.min.y).toBeCloseTo(0);
  expect(bounds.min.z).toBeCloseTo(0);
  expect(bounds.max.x).toBeCloseTo(20);
  expect(bounds.max.y).toBeCloseTo(30);
  expect(bounds.max.z).toBeCloseTo(10);
});
test("cable distance guides and plug envelopes decode without pretending to be PCB geometry", async () => {
  const model = await MechanicalScene.decode({
    item: mechanicalItem("guide", "import", "Cable guide"),
    guide: { from: [0, 0, 3], to: [30, 20, 3], color: 0x64cbd2 },
    selectable: false,
    origin: [0, 0, 0],
  });
  const b = new Box3().setFromObject(model);
  expect(b.min.x).toBeCloseTo(-1);
  expect(b.max.x).toBeCloseTo(31);
  expect(b.max.y).toBeCloseTo(21);
});
