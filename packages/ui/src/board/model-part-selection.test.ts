import { expect, test } from "bun:test";
import * as THREE from "three";
import { nativeModelParts, modelPartReference, ModelPartTint } from "./model-part-selection";
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

test("color selection restores shared materials when switching, clearing, and disposing", () => {
  const shared = new THREE.MeshStandardMaterial({ color: 0x885522, emissive: 0x112233 });
  const geometry = new THREE.BoxGeometry();
  const a = new THREE.Mesh(geometry, shared), b = new THREE.Mesh(geometry, shared);
  const originalColor = shared.color.getHex(), tint = new ModelPartTint();
  for (let i = 0; i < 30; i++) {
    const selected = i % 2 ? a : b, other = i % 2 ? b : a;
    expect(tint.apply([selected, selected])).toBe(1);
    expect(selected.material).not.toBe(shared); expect(selected.material.color.getHex()).toBe(0x22d3ee);
    expect(other.material).toBe(shared); expect(shared.color.getHex()).toBe(originalColor);
  }
  let disposed = 0; a.material.addEventListener("dispose", () => disposed++);
  tint.clear(); expect(disposed).toBe(1); expect(a.material).toBe(shared); expect(b.material).toBe(shared);
  expect(shared.emissive.getHex()).toBe(0x112233);
  tint.clear(); expect(disposed).toBe(1);
  shared.dispose(); geometry.dispose();
});
test("color selection handles material arrays and restores texture ownership", () => {
  const texture = new THREE.Texture(), original = new THREE.MeshStandardMaterial({ map: texture });
  const materials = [original, new THREE.MeshBasicMaterial({ color: 0x111111 })];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), materials), tint = new ModelPartTint();
  let textureDisposals = 0; texture.addEventListener("dispose", () => textureDisposals++);
  tint.apply([mesh]); expect(mesh.material).not.toBe(materials); expect((mesh.material[0] as THREE.MeshStandardMaterial).map).toBe(texture);
  tint.clear(); expect(mesh.material).toBe(materials); expect(textureDisposals).toBe(0);
  materials.forEach(material=>material.dispose()); mesh.geometry.dispose(); texture.dispose();
});
