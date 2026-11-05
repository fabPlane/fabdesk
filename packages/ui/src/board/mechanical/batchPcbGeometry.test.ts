import { expect, test } from "bun:test";
import * as T from "three";
import { batchPcbGeometry } from "./batchPcbGeometry";
test("batching preserves world bounds, material identity and every triangle across reflected transforms", () => {
  const root = new T.Group(),
    parent = new T.Group();
  parent.scale.set(-2, 3, 4);
  parent.position.set(7, 8, 9);
  root.add(parent);
  const materials = [
    new T.MeshStandardMaterial({ color: 0xabcdef }),
    new T.MeshStandardMaterial({ color: 0xff4400 }),
  ];
  let triangles = 0;
  for (let i = 0; i < 100; i++) {
    const g = new T.BoxGeometry(1, 2, 3);
    triangles += g.index!.count / 3;
    const m = new T.Mesh(g, materials[i % 2]!);
    m.position.x = i * 2;
    parent.add(m);
  }
  const before = new T.Box3().setFromObject(root);
  batchPcbGeometry(root);
  const meshes: T.Mesh[] = [];
  root.traverse((o) => {
    if (o instanceof T.Mesh) meshes.push(o);
  });
  const after = new T.Box3().setFromObject(root);
  expect(meshes).toHaveLength(2);
  expect(after.min.toArray()).toEqual(before.min.toArray());
  expect(after.max.toArray()).toEqual(before.max.toArray());
  expect(meshes.reduce((n, m) => n + m.geometry.index!.count / 3, 0)).toBe(triangles);
  expect(meshes.map((m) => m.material)).toEqual(materials);
  // Signed volume must stay outward after baking a reflection.
  for (const m of meshes) {
    let volume = 0;
    const p = m.geometry.getAttribute("position"),
      idx = m.geometry.index!;
    for (let i = 0; i < idx.count; i += 3) {
      const a = new T.Vector3().fromBufferAttribute(p, idx.getX(i)),
        b = new T.Vector3().fromBufferAttribute(p, idx.getX(i + 1)),
        c = new T.Vector3().fromBufferAttribute(p, idx.getX(i + 2));
      volume += a.dot(b.cross(c)) / 6;
    }
    expect(volume).toBeGreaterThan(0);
  }
});
test("transparent surfaces retain separate objects for correct depth sorting", () => {
  const root = new T.Group(),
    material = new T.MeshBasicMaterial({ transparent: true, opacity: 0.5 });
  root.add(new T.Mesh(new T.BoxGeometry(), material), new T.Mesh(new T.BoxGeometry(), material));
  batchPcbGeometry(root);
  expect(root.children).toHaveLength(2);
});
test("coplanar transparent patches batch while separate depths and hidden parents stay separate", () => {
  const root = new T.Group(),
    material = new T.MeshBasicMaterial({ transparent: true, opacity: 0.9 });
  for (const z of [0, 0, 1, 1]) {
    const m = new T.Mesh(new T.PlaneGeometry(), material);
    m.position.z = z;
    root.add(m);
  }
  const hidden = new T.Group();
  hidden.visible = false;
  hidden.add(new T.Mesh(new T.PlaneGeometry(), material));
  root.add(hidden);
  batchPcbGeometry(root);
  const visible = root.children.filter((o) => o instanceof T.Mesh) as T.Mesh[];
  expect(visible).toHaveLength(2);
  expect(visible.every((m) => m.material === material && m.geometry.index!.count === 12)).toBe(
    true,
  );
  expect(hidden.children).toHaveLength(1);
  expect(hidden.visible).toBe(false);
});
