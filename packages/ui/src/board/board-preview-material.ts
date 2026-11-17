import { Material, MeshStandardMaterial } from "three";

/** KiCad ink is a surface, not glass. Opaque depth-tested ink avoids the
 * translucent soldermask being sorted over individual letters at oblique angles.
 * Clone only this known native surface; component/enclosure transparency stays intact. */
export function boardPreviewMaterial(material: Material, meshName: string): Material {
  if (meshName !== "board_silkscreen" || !(material instanceof MeshStandardMaterial) || material.map || material.alphaMap) return material;
  const ink = material.clone();
  ink.transparent = false;
  ink.opacity = 1;
  ink.depthWrite = true;
  return ink;
}
