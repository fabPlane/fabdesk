import { expect, test } from "bun:test";
import { Box3, Group, Mesh, MeshStandardMaterial, PlaneGeometry, Raycaster, Vector3 } from "three";
import { batchPreviewMeshes } from "./preview-mesh-batching";
import { nativeModelParts, modelPartReference, ModelPartTint } from "./model-part-selection";

test("batches primitives without losing transforms, triangles, references or selection", () => {
  const root = new Group(), material = new MeshStandardMaterial();
  for (const [i, ref] of ["U1", "U2"].entries()) {
    const part = new Group(); part.userData["nativeComponentName"] = ref; part.position.x = i * 10;
    for (let j = 0; j < 3; j++) { const mesh = new Mesh(new PlaneGeometry(1, 1), material); mesh.position.x = j; part.add(mesh); }
    root.add(part);
  }
  const before = new Box3().setFromObject(root);
  batchPreviewMeshes(root);
  expect(root.children.map(p => p.children.length)).toEqual([1, 1]);
  expect(new Box3().setFromObject(root).equals(before)).toBe(true);
  const parts = nativeModelParts(root, ["U1", "U2"]);
  const hit = new Raycaster(new Vector3(1, 0, 5), new Vector3(0, 0, -1)).intersectObject(root)[0];
  expect(modelPartReference(hit?.object ?? null, parts)).toBe("U1");
  const first = root.children[0]!.children[0] as Mesh;
  expect(first.geometry.index!.count).toBe(18);
  const tint = new ModelPartTint(); tint.apply(parts.get("U1")!);
  expect(first.material).not.toBe(material);
  expect((root.children[1]!.children[0] as Mesh).material).toBe(material);
  tint.clear(); expect(first.material).toBe(material);
});

test("keeps transparent sorting, named parts, mirrored and partial geometry intact", () => {
  const root = new Group(), material = new MeshStandardMaterial(), glass = new MeshStandardMaterial({ transparent: true });
  const opaque = () => new Mesh(new PlaneGeometry(), material);
  const named = opaque(); named.userData["nativeComponentName"] = "R1";
  const mirrored = opaque(); mirrored.scale.x = -1;
  const partial = opaque(); partial.geometry.setDrawRange(0, 3);
  const transparent = new Mesh(new PlaneGeometry(), glass);
  root.add(named, mirrored, partial, transparent, new Mesh(new PlaneGeometry(), glass));
  batchPreviewMeshes(root);
  expect(root.children.length).toBe(5);
  expect(root.children).toContain(named);
  expect(root.children).toContain(transparent);
});

test("does not dispose geometry still used by an unbatched mesh", () => {
  const root = new Group(), part = new Group(), geometry = new PlaneGeometry(), material = new MeshStandardMaterial();
  let disposed = false; geometry.addEventListener("dispose", () => { disposed = true; });
  part.add(new Mesh(geometry, material), new Mesh(geometry, material)); root.add(part, new Mesh(geometry, material));
  batchPreviewMeshes(root);
  expect(part.children.length).toBe(1); expect(disposed).toBe(false);
});
