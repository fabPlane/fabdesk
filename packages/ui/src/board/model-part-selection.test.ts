import { expect, test } from "bun:test";
import * as THREE from "three";
import { nativeModelParts, modelPartReference } from "./model-part-selection";
const part = (name: string, x = 0) => { const group = new THREE.Group(); group.name = name.replace(/[\[\]]/g, ""); group.userData["nativeComponentName"] = name; const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()); mesh.position.x = x; group.add(mesh); return { group, mesh }; };
test("3D selection uses exact exported references, including brackets, and child meshes inherit their part", () => {
  const scene = new THREE.Group(), a = part("R[1]"), b = part("R1", 2); scene.add(a.group, b.group);
  const parts = nativeModelParts(scene, ["R[1]"]);
  expect([...parts.keys()]).toEqual(["R[1]"]); expect(modelPartReference(a.mesh, parts)).toBe("R[1]"); expect(modelPartReference(b.mesh, parts)).toBeNull();
});
test("unmapped geometry, missing models, and geometry without an exporter reference stay unselectable", () => {
  const scene = new THREE.Group(), a = part("U1"), unnamed = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); unnamed.name = "R1";
  scene.add(a.group, unnamed); const parts = nativeModelParts(scene, ["U1", "R1", "R2"]);
  expect([...parts.keys()]).toEqual(["U1"]); expect(modelPartReference(unnamed, parts)).toBeNull();
});
test("raycast selects the visible component and does not probe through foreground board geometry", () => {
  const scene = new THREE.Group(), a = part("U1"); scene.add(a.group); scene.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1));
  const parts = nativeModelParts(scene, ["U1"]);
  expect(modelPartReference(ray.intersectObject(scene, true)[0]!.object, parts)).toBe("U1");
  const board = new THREE.Mesh(new THREE.BoxGeometry(5, 5, .2), new THREE.MeshBasicMaterial()); board.position.z = 2; scene.add(board); scene.updateMatrixWorld(true);
  expect(modelPartReference(ray.intersectObject(scene, true)[0]!.object, parts)).toBeNull();
});
