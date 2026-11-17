import { BufferGeometry, Mesh, Object3D, SkinnedMesh, InstancedMesh } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Batch static opaque primitives within their original component only. No
 * simplification: coordinates, normals, materials and selectable parents survive. */
export function batchPreviewMeshes(root: Object3D) {
  const parents: Object3D[] = [];
  root.traverse(object => { if (object.children.length > 1) parents.push(object); });
  const retired = new Set<BufferGeometry>();
  for (const parent of parents) {
    const batches = new Map<string, Mesh[]>();
    for (const child of parent.children) {
      if (!(child instanceof Mesh) || child instanceof SkinnedMesh || child instanceof InstancedMesh || child.children.length || !child.visible ||
          Array.isArray(child.material) || child.material.transparent || typeof child.userData["nativeComponentName"] === "string") continue;
      const geometry: BufferGeometry = child.geometry;
      if (geometry.groups.length || Object.keys(geometry.morphAttributes).length || geometry.drawRange.start !== 0 || geometry.drawRange.count !== Infinity) continue;
      child.updateMatrix();
      if (child.matrix.determinant() <= 0) continue;
      const attributes = Object.entries(geometry.attributes).sort(([a], [b]) => a.localeCompare(b));
      if (attributes.some(([, attr]) => "isInterleavedBufferAttribute" in attr)) continue;
      const signature = attributes.map(([name, attr]) => `${name}:${attr.itemSize}:${attr.normalized}:${attr.array.constructor.name}`).join(";");
      const key = `${child.material.uuid}:${!!geometry.index}:${signature}:${child.renderOrder}:${child.layers.mask}:${child.castShadow}:${child.receiveShadow}:${child.frustumCulled}`;
      const batch = batches.get(key) ?? []; batch.push(child); batches.set(key, batch);
    }
    for (const meshes of batches.values()) {
      if (meshes.length < 2) continue;
      const transformed = meshes.map(mesh => mesh.geometry.clone().applyMatrix4(mesh.matrix));
      let geometry: BufferGeometry | null;
      try { geometry = mergeGeometries(transformed); }
      finally { for (const copy of transformed) copy.dispose(); }
      if (!geometry) continue;
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      const first = meshes[0]!;
      const merged = new Mesh(geometry, first.material);
      merged.name = first.name; merged.userData = { ...first.userData };
      merged.renderOrder = first.renderOrder; merged.layers.mask = first.layers.mask;
      merged.castShadow = first.castShadow; merged.receiveShadow = first.receiveShadow; merged.frustumCulled = first.frustumCulled;
      for (const mesh of meshes) { parent.remove(mesh); retired.add(mesh.geometry); }
      parent.add(merged);
    }
  }
  // A different component may still use an original shared geometry.
  root.traverse(object => { if (object instanceof Mesh) retired.delete(object.geometry); });
  for (const geometry of retired) geometry.dispose();
}
