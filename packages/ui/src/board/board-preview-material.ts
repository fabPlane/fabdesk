import { Color, Material, Mesh, MeshStandardMaterial } from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";

// KiCad's default colors are linear glTF values, not CSS/sRGB colors. Only the
// known defaults are retuned: a deliberately red/blue/custom board stays that way.
const defaultMask = new Color().setRGB(.08, .2, .14);
const defaultCore = new Color().setRGB(.42, .45, .29);
const defaultCopper = new Color().setRGB(.7, .61, 0);
function matches(color: Color, expected: Color) {
  return Math.max(Math.abs(color.r - expected.r), Math.abs(color.g - expected.g), Math.abs(color.b - expected.b)) < .0001;
}

/** KiCad ink is a surface, not glass. Opaque depth-tested ink avoids the
 * translucent soldermask being sorted over individual letters at oblique angles.
 * Clone only this known native surface; component/enclosure transparency stays intact. */
export function boardPreviewMaterial(material: Material, meshName: string): Material {
  if (!(material instanceof MeshStandardMaterial) || material.map || material.alphaMap || material.vertexColors ||
      !["board_silkscreen", "board_soldermask", "board_PCB", "board_copper"].includes(meshName)) return material;
  const surface = material.clone();
  if (meshName === "board_silkscreen") {
    surface.transparent = false;
    surface.opacity = 1;
    surface.depthWrite = true;
    surface.roughness = .9;
    surface.metalness = 0;
    surface.envMapIntensity = .2;
  } else if (meshName === "board_soldermask") {
    if (matches(surface.color, defaultMask)) {
      surface.color.set(0x12643b);
      surface.opacity = .95;
    }
    surface.roughness = .5;
    surface.metalness = 0;
    surface.envMapIntensity = .35;
    // Each mask is already a thin surface, not a glass volume. Rendering both
    // sides in separate transparent passes adds cost without useful thickness.
    surface.forceSinglePass = true;
  } else if (meshName === "board_PCB") {
    if (matches(surface.color, defaultCore)) surface.color.set(0x86764d);
    surface.roughness = .85;
    surface.metalness = 0;
    surface.envMapIntensity = .25;
  } else {
    if (matches(surface.color, defaultCopper)) surface.color.set(0xd4ad5e);
    surface.roughness = .35;
    surface.metalness = 1;
    surface.envMapIntensity = .8;
  }
  return surface;
}

/** Use native mesh identity, never component names or guessed component colors.
 * Cache by surface AND source material: exporters may share one material across
 * several meshes. Both the board preview and mechanical workspace use this path. */
export function prepareBoardPreviewMaterials(model: GLTF) {
  const cache = new Map<string, Map<Material, Material>>();
  const replaced = new Set<Material>();
  model.scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const index = model.parser.associations.get(object)?.meshes;
    const name: unknown = index === undefined ? undefined : model.parser.json.meshes?.[index]?.name;
    if (typeof name !== "string" || !["board_silkscreen", "board_soldermask", "board_PCB", "board_copper"].includes(name)) return;
    let surfaces = cache.get(name);
    if (!surfaces) { surfaces = new Map(); cache.set(name, surfaces); }
    const prepare = (material: Material) => {
      let surface = surfaces.get(material);
      if (!surface) { surface = boardPreviewMaterial(material, name); surfaces.set(material, surface); }
      if (surface !== material) replaced.add(material);
      return surface;
    };
    object.material = Array.isArray(object.material) ? object.material.map(prepare) : prepare(object.material);
  });
  model.scene.traverse(object => {
    if (object instanceof Mesh) for (const material of Array.isArray(object.material) ? object.material : [object.material]) replaced.delete(material);
  });
  for (const material of replaced) material.dispose();
}
