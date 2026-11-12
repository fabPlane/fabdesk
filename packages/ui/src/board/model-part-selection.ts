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


/** Clone only selected meshes' materials: shared originals must never tint other parts. */
export class ModelPartTint {
  private originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private clones: THREE.Material[] = [];
  apply(objects: readonly THREE.Object3D[]) {
    this.clear();
    for (const object of objects) object.traverse(node => {
      if (!(node instanceof THREE.Mesh) || this.originals.has(node)) return;
      this.originals.set(node, node.material);
      const tint = (original: THREE.Material) => {
        const material = original.clone();
        if ("color" in material && material.color instanceof THREE.Color) material.color.setHex(0x22d3ee);
        if ("emissive" in material && material.emissive instanceof THREE.Color) material.emissive.setHex(0x087d91);
        this.clones.push(material);
        return material;
      };
      node.material = Array.isArray(node.material) ? node.material.map(tint) : tint(node.material);
    });
    return this.originals.size;
  }
  clear() {
    for (const [mesh, material] of this.originals) mesh.material = material;
    this.originals.clear();
    for (const material of this.clones) material.dispose();
    this.clones = [];
  }
}
