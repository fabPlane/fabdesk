import { expect, test } from "bun:test";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Raycaster, Vector3 } from "three";
import { BoardComponentVisibility, modelObjectVisible } from "./board-component-visibility";

test("bare board preserves all native surfaces and restores nested components without rebuilding geometry", () => {
  const scene = new Group(), part = new Group(), geometry = new BoxGeometry(), material = new MeshStandardMaterial();
  const surfaces = ["PCB", "soldermask", "silkscreen", "copper"].map(kind => {
    const mesh = new Mesh(geometry, material); mesh.userData["nativeBoardSurface"] = `board_${kind}`; return mesh;
  });
  const body = new Mesh(geometry, material), lead = new Mesh(geometry, material), hidden = new Mesh(geometry, material);
  hidden.visible = false; part.add(body, lead, hidden); part.position.set(1, 2, 3); scene.add(...surfaces, part);
  const visibility = new BoardComponentVisibility(scene);
  visibility.setAssembled(false);
  expect(surfaces.every(mesh => mesh.visible)).toBe(true);
  expect(body.visible).toBe(false); expect(lead.visible).toBe(false);
  expect(part.visible).toBe(true);
  visibility.setAssembled(true);
  expect(body.visible).toBe(true); expect(lead.visible).toBe(true); expect(hidden.visible).toBe(false);
  expect(body.geometry).toBe(geometry); expect(body.material).toBe(material);
  expect(part.position.toArray()).toEqual([1, 2, 3]);
});

test("unrecognized authored models are never hidden", () => {
  const model = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  new BoardComponentVisibility(model).setAssembled(false);
  expect(model.visible).toBe(true);
});

test("hidden meshes and hidden ancestors cannot intercept bare-board selection", () => {
  const scene = new Group(), part = new Group(), mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
  part.add(mesh); scene.add(part); scene.updateMatrixWorld(true);
  const ray = new Raycaster(new Vector3(0, 0, 5), new Vector3(0, 0, -1));
  mesh.visible = false;
  expect(ray.intersectObject(scene, true).length).toBeGreaterThan(0);
  expect(ray.intersectObject(scene, true).filter(hit => modelObjectVisible(hit.object))).toHaveLength(0);
  mesh.visible = true; part.visible = false;
  expect(modelObjectVisible(mesh)).toBe(false);
  part.visible = true; expect(modelObjectVisible(mesh)).toBe(true);
});
