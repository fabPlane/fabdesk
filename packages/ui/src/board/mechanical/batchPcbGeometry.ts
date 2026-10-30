import * as T from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Batch opaque surfaces and coplanar PCB layers without simplifying triangles. */
export function batchPcbGeometry(root: T.Group) {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert();
  const buckets = new Map<string, T.Mesh[]>();
  root.traverse((o) => {
    if (
      !(o instanceof T.Mesh) ||
      o instanceof T.SkinnedMesh ||
      o instanceof T.InstancedMesh ||
      Array.isArray(o.material) ||
      Object.keys(o.geometry.morphAttributes).length ||
      o.geometry.drawRange.start !== 0 ||
      o.geometry.drawRange.count !== Infinity ||
      !o.visible
    )
      return;
    for (let parent = o.parent; parent; parent = parent.parent) if (!parent.visible) return;
    const geometry: T.BufferGeometry = o.geometry;
    let plane = "solid";
    if (o.material.transparent) {
      // Native copper/solder-mask layers contain thousands of separate coplanar
      // patches. Same-material patches in one plane do not need individual sorting.
      // Keep curved/volumetric transparent parts and different planes separate.
      geometry.computeBoundingBox();
      const box = geometry
        .boundingBox!.clone()
        .applyMatrix4(inverse.clone().multiply(o.matrixWorld));
      const axis = (["x", "y", "z"] as const).find((a) => Math.abs(box.max[a] - box.min[a]) < 1e-9);
      if (!axis) return;
      plane = `${axis}:${box.min[axis].toFixed(9)}`;
    }
    const attrs = Object.entries(geometry.attributes)
      .map(([k, a]) => `${k}:${a.itemSize}:${a.normalized}:${a.array.constructor.name}`)
      .sort()
      .join();
    const key = `${o.material.uuid}:${!!o.geometry.index}:${attrs}:${o.renderOrder}:${plane}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(o);
    else buckets.set(key, [o]);
  });
  const released = new Set<T.BufferGeometry>();
  for (const meshes of buckets.values()) {
    if (meshes.length < 2) continue;
    const geometries = meshes.map((mesh) => {
      const g = mesh.geometry.clone(),
        matrix = inverse.clone().multiply(mesh.matrixWorld);
      g.applyMatrix4(matrix);
      if (matrix.determinant() < 0) {
        if (g.index) {
          const a = g.index.array;
          for (let i = 0; i < a.length; i += 3) [a[i + 1], a[i + 2]] = [a[i + 2]!, a[i + 1]!];
        } else {
          for (const a of Object.values(g.attributes)) {
            for (let i = 0; i < a.count; i += 3)
              for (let c = 0; c < a.itemSize; c++) {
                const x = (i + 1) * a.itemSize + c,
                  y = (i + 2) * a.itemSize + c;
                [a.array[x], a.array[y]] = [a.array[y]!, a.array[x]!];
              }
          }
        }
        const tangent = g.getAttribute("tangent");
        if (tangent) for (let i = 0; i < tangent.count; i++) tangent.setW(i, -tangent.getW(i));
      }
      return g;
    });
    const merged = mergeGeometries(geometries, false);
    geometries.forEach((g) => g.dispose());
    if (!merged) continue;
    const batch = new T.Mesh(merged, meshes[0]!.material);
    batch.renderOrder = meshes[0]!.renderOrder;
    batch.name = "PCB surfaces";
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    root.add(batch);
    for (const mesh of meshes) {
      released.add(mesh.geometry);
      mesh.removeFromParent();
    }
  }
  root.traverse((o) => {
    if (o instanceof T.Mesh) released.delete(o.geometry);
  });
  released.forEach((g) => g.dispose());
  // Imported GLBs can leave thousands of empty transform nodes behind after batching.
  const prune = (o: T.Object3D) => {
    for (const child of [...o.children]) {
      prune(child);
      if (!child.children.length && (child instanceof T.Group || child.type === "Object3D"))
        child.removeFromParent();
    }
  };
  prune(root);
}
