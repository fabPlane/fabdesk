import { expect, test } from "bun:test";
import * as T from "three";
import { STLExporter } from "three/addons/exporters/STLExporter.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { mechanicalItem } from "@fabdesk/client-core";
import { MechanicalScene, type SceneModel } from "./MechanicalScene";

type Model = { source: SceneModel; object: T.Group };

/** Exercise the real scene methods without constructing WebGL, DOM or native input controls. */
function harness(entries: Model[] = [], width = 1000, height = 600) {
  const camera = new T.PerspectiveCamera(38, width / height, 0.01, 1e6);
  camera.up.set(0, 0, 1);
  camera.position.set(200, -200, 200);
  const host = { clientWidth: width, clientHeight: height };
  const orbit = {
    target: new T.Vector3(),
    minDistance: 0.1,
    maxDistance: 1e5,
    update() {
      camera.lookAt(this.target);
      camera.updateMatrixWorld();
    },
  };
  const gizmo = {
    object: null as T.Object3D | null,
    dragging: false,
    showX: true,
    showY: true,
    showZ: true,
    detach() {
      this.object = null;
    },
    attach(object: T.Object3D) {
      this.object = object;
    },
    setMode() {},
  };
  const stage = new T.Scene();
  const models = new Map(entries.map((model) => [model.source.item.id, model]));
  for (const { object } of entries) stage.add(object);
  const scene: MechanicalScene = Object.assign(Object.create(MechanicalScene.prototype), {
    host,
    camera,
    orbit,
    gizmo,
    models,
    scene: stage,
    viewportInsets: { left: 0, right: 0, top: 0, bottom: 0 },
    clippingBounds: new T.Box3().setFromObject(stage),
    spaceOutline: null,
    selection: null,
    selectionBox: null,
    selectionOutline: null,
    selectionObject: null,
    selectionEdges: [],
    mode: "orbit",
    explode: 0,
    planarPlacement: false,
    measurement: null,
    point: null,
    callbacks: { measured() {} },
    render() {},
    clearHover() {},
  });
  orbit.update();
  return { scene, camera, orbit, gizmo, host, stage, models };
}

function boxModel(
  id: string,
  kind: SceneModel["item"]["kind"],
  size: [number, number, number],
): Model {
  const object = new T.Group();
  object.add(new T.Mesh(new T.BoxGeometry(...size), new T.MeshBasicMaterial()));
  return { object, source: { item: mechanicalItem(id, kind) } };
}

function stlData(object: T.Object3D): ArrayBuffer {
  const data = new STLExporter().parse(object, { binary: true });
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

function signedVolume(geometry: T.BufferGeometry) {
  const positions = geometry.getAttribute("position");
  let volume = 0;
  for (let i = 0; i < positions.count; i += 3) {
    const a = new T.Vector3().fromBufferAttribute(positions, i);
    const b = new T.Vector3().fromBufferAttribute(positions, i + 1);
    const c = new T.Vector3().fromBufferAttribute(positions, i + 2);
    volume += a.dot(b.cross(c)) / 6;
  }
  return volume;
}

test("imported enclosure STL retains offset pivot, rotation, scale and mirrored winding without altering the source", async () => {
  const raw = new T.Mesh(
    new T.BoxGeometry(4, 7, 11).translate(8, 12, -5),
    new T.MeshBasicMaterial(),
  );
  const data = stlData(raw),
    bytesBefore = new Uint8Array(data).slice();
  const item = mechanicalItem("asymmetric.stl", "import");
  item.position = [23, -40, 9];
  item.rotation = [20, 35, 71];
  item.scale = 1.7;
  const object = await MechanicalScene.decode({ item, data });
  object.position.fromArray(item.position);
  object.rotation.set(...(item.rotation.map(T.MathUtils.degToRad) as [number, number, number]));
  object.scale.setScalar(item.scale);
  const mesh = object.children[0]!.children[0] as T.Mesh;
  mesh.scale.x = -1;
  object.updateWorldMatrix(true, true);
  const expected = new T.Box3().setFromObject(object);
  const positionsBefore = Array.from(mesh.geometry.getAttribute("position").array);
  const transformsBefore = object.toJSON();
  const { scene } = harness([{ source: { item, data }, object }]);
  const blob = scene.exportModelStl(item.id);
  const result = new STLLoader().parse(await blob.arrayBuffer());
  result.computeBoundingBox();
  expect(blob.type).toBe("model/stl");
  expect(result.boundingBox!.min.distanceTo(expected.min)).toBeLessThan(1e-4);
  expect(result.boundingBox!.max.distanceTo(expected.max)).toBeLessThan(1e-4);
  expect(signedVolume(result)).toBeCloseTo(4 * 7 * 11 * 1.7 ** 3, 2);
  expect(new Uint8Array(data)).toEqual(bytesBefore);
  expect(Array.from(mesh.geometry.getAttribute("position").array)).toEqual(positionsBefore);
  expect(object.toJSON()).toEqual(transformsBefore);
});

test("imported STL includes every GLB instance and its metre-to-millimetre transform", async () => {
  const instances = new T.InstancedMesh(
    new T.BoxGeometry(0.002, 0.003, 0.005),
    new T.MeshBasicMaterial(),
    2,
  );
  instances.setMatrixAt(0, new T.Matrix4().makeTranslation(-0.012, 0, 0));
  instances.setMatrixAt(1, new T.Matrix4().makeTranslation(0.016, 0.008, 0.001));
  const object = new T.Group();
  object.scale.setScalar(1000);
  object.add(instances);
  const before = Array.from(instances.instanceMatrix.array);
  const item = mechanicalItem("instances.glb", "import");
  const { scene } = harness([{ source: { item, data: new ArrayBuffer(1) }, object }]);
  const result = new STLLoader().parse(await scene.exportModelStl(item.id).arrayBuffer());
  result.computeBoundingBox();
  expect(result.getAttribute("position").count).toBe(72);
  expect(result.boundingBox!.min.x).toBeCloseTo(-13);
  expect(result.boundingBox!.max.x).toBeCloseTo(17);
  expect(result.boundingBox!.max.y).toBeCloseTo(9.5);
  expect(signedVolume(result)).toBeCloseTo(60, 3);
  expect(Array.from(instances.instanceMatrix.array)).toEqual(before);
  expect(object.scale.toArray()).toEqual([1000, 1000, 1000]);
});

test("only loaded imported models can become enclosure STL copies", () => {
  const generated = boxModel("generated.stl", "base", [4, 7, 11]);
  generated.source.data = new ArrayBuffer(1);
  const unloaded = boxModel("unloaded.stl", "import", [4, 7, 11]);
  const { scene } = harness([generated, unloaded]);
  for (const id of ["missing", generated.source.item.id, unloaded.source.item.id])
    expect(() => scene.exportModelStl(id)).toThrow("loaded imported");
});

test("all orientation views fit asymmetric assemblies beside the floating card", () => {
  const model = boxModel("case.stl", "base", [140, 200, 20]);
  const { scene, camera, orbit } = harness([model]);
  scene.setViewportInsets({ left: 310, bottom: 70 });
  for (const view of ["top", "bottom", "front", "back", "left", "right", "iso"] as const) {
    scene.view(view);
    const center = scene.projectModel(model.source.item.id)!;
    expect(center.x).toBeCloseTo(655);
    expect(center.y).toBeCloseTo(265);
    for (const x of [-70, 70])
      for (const y of [-100, 100])
        for (const z of [-10, 10]) {
          const point = scene.projectPoint(x, y, z);
          expect(point).not.toBeNull();
          expect(point!.x).toBeGreaterThanOrEqual(310);
          expect(point!.x).toBeLessThanOrEqual(1000);
          expect(point!.y).toBeGreaterThanOrEqual(0);
          expect(point!.y).toBeLessThanOrEqual(530);
        }
  }
  const fittedDistance = camera.position.distanceTo(orbit.target);
  scene.zoom(0.5);
  expect(camera.position.distanceTo(orbit.target)).toBeCloseTo(fittedDistance / 2);
  const position = camera.position.clone();
  for (const factor of [NaN, Infinity, 0, -1]) scene.zoom(factor);
  expect(camera.position.equals(position)).toBe(true);
  scene.zoom(1e12);
  expect(camera.position.distanceTo(orbit.target)).toBeCloseTo(orbit.maxDistance);
  scene.fit();
  expect(camera.position.distanceTo(orbit.target)).toBeCloseTo(fittedDistance);
});

test("oversized floating cards leave a usable narrow viewport and projection ignores hidden or offscreen models", () => {
  const model = boxModel("case.stl", "base", [140, 200, 20]);
  const { scene } = harness([model], 400, 260);
  scene.setViewportInsets({ left: 1000, right: 1000, top: 1000, bottom: 1000 });
  for (const x of [-70, 70])
    for (const y of [-100, 100])
      for (const z of [-10, 10]) {
        const p = scene.projectPoint(x, y, z)!;
        expect(p.x).toBeGreaterThanOrEqual(100);
        expect(p.x).toBeLessThanOrEqual(300);
        expect(p.y).toBeGreaterThanOrEqual(30);
        expect(p.y).toBeLessThanOrEqual(230);
      }
  model.object.visible = false;
  expect(scene.projectModel(model.source.item.id)).toBeNull();
  expect(scene.projectModel("missing")).toBeNull();
  expect(scene.projectPoint(Infinity, 0, 0)).toBeNull();
  expect(scene.projectPoint(1e9, 1e9, 1e9)).toBeNull();
});

test("case selection highlights its edges without attaching a move gizmo until explicitly enabled", () => {
  const model = boxModel("case.stl", "base", [140, 200, 20]);
  model.source.enclosure = true;
  model.source.selectable = true;
  const board = boxModel("board.stl", "board", [30, 20, 1.6]);
  const { scene, gizmo, stage } = harness([model, board]);
  scene.setMode("translate");
  scene.select(model.source.item.id);
  expect(gizmo.object).toBeNull();
  const outline = stage.children.find(
    (part) => part !== model.object && part !== board.object,
  ) as T.Group;
  const edge = outline.children[0] as T.LineSegments<T.BufferGeometry, T.LineBasicMaterial>;
  expect(edge.material.color.getHex()).toBe(0x25d9d0);
  scene.select(model.source.item.id);
  expect(stage.children).toContain(outline);
  model.source.transformable = true;
  scene.select(model.source.item.id);
  expect(gizmo.object).toBe(model.object);
  model.source.transformable = false;
  scene.setMode("rotate");
  expect(gizmo.object).toBeNull();
  scene.select(board.source.item.id);
  expect(gizmo.object).toBe(board.object);
  expect(stage.children).not.toContain(outline);
  scene.select(null);
  expect(gizmo.object).toBeNull();
  expect(stage.children).toEqual([model.object, board.object]);
});
