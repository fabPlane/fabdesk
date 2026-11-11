import * as THREE from "three";

/** Only exact exporter node references from a source-verified GLB may identify parts. */
export function nativeModelParts(model: THREE.Object3D, references: readonly string[]) {
  const allowed = new Set(references), parts = new Map<string, THREE.Object3D[]>();
  model.updateWorldMatrix(true, true);
  model.traverse(object => {
    const ref: unknown = object.userData["nativeComponentName"];
    if (typeof ref !== "string" || !allowed.has(ref) || new THREE.Box3().setFromObject(object).isEmpty()) return;
    const objects = parts.get(ref) ?? []; objects.push(object); parts.set(ref, objects);
  });
  return parts;
}
/** The foremost hit owns the click. Never select an occluded part through the board. */
export function modelPartReference(object: THREE.Object3D | null, parts: Map<string, THREE.Object3D[]>) {
  while (object) {
    const ref: unknown = object.userData["nativeComponentName"];
    if (typeof ref === "string" && parts.get(ref)?.includes(object)) return ref;
    object = object.parent;
  }
  return null;
}
