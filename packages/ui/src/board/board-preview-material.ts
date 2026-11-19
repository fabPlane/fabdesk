import { Color, Material, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D } from "three";
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
      surface.color.set(0x033e1b);
      // Keep the actual outer copper visible through the coating. An almost
      // opaque mask erases trace/zone detail even when it exists in the export.
      surface.opacity = .84;
    }
    surface.roughness = .7;
    surface.metalness = 0;
    surface.envMapIntensity = .2;
    // Each mask is already a thin surface, not a glass volume. Rendering both
    // sides in separate transparent passes adds cost without useful thickness.
    surface.forceSinglePass = true;
  } else if (meshName === "board_PCB") {
    if (matches(surface.color, defaultCore)) surface.color.set(0x86764d);
    surface.roughness = .85;
    surface.metalness = 0;
    surface.envMapIntensity = .25;
  } else {
    if (matches(surface.color, defaultCopper)) surface.color.set(0xd6b64c);
    surface.roughness = .42;
    surface.metalness = 1;
    surface.envMapIntensity = .8;
  }
  surface.userData["boardPreviewSurface"] = meshName;
  return surface;
}

/** Flat inspection uses actual board geometry with unlit colors, so gold pads
 * and white ink stay readable at either side. Components and authored textures
 * retain their materials. One cached material per surface, not per primitive. */
export class BoardInspectionMaterials {
  private entries: { mesh: Mesh; original: Material | Material[]; flat: Material | Material[] }[] = [];
  private flats = new Map<Material, Material>();
  constructor(root: Object3D) {
    root.traverse(object => {
      if (!(object instanceof Mesh)) return;
      const prepare = (source: Material) => {
        if (!(source instanceof MeshStandardMaterial) || !source.userData["boardPreviewSurface"]) return source;
        let flat = this.flats.get(source);
        if (!flat) {
          flat = new MeshBasicMaterial({ color: source.color, opacity: source.opacity,
            transparent: source.transparent, side: source.side, depthTest: source.depthTest,
            depthWrite: source.depthWrite, forceSinglePass: source.forceSinglePass,
            polygonOffset: source.polygonOffset, polygonOffsetFactor: source.polygonOffsetFactor,
            polygonOffsetUnits: source.polygonOffsetUnits, toneMapped: false });
          this.flats.set(source, flat);
        }
        return flat;
      };
      const original = object.material;
      const flat = Array.isArray(original) ? original.map(prepare) : prepare(original);
      const changed = Array.isArray(original) && Array.isArray(flat)
        ? original.some((material, i) => material !== flat[i]) : original !== flat;
      if (changed) this.entries.push({ mesh: object, original, flat });
    });
  }
  setFlat(flat: boolean) {
    for (const entry of this.entries) entry.mesh.material = flat ? entry.flat : entry.original;
  }
  dispose() {
    this.setFlat(false);
    for (const material of this.flats.values()) material.dispose();
    this.flats.clear(); this.entries = [];
  }
}

/** Use native mesh identity, never component names or guessed component colors.
 * Cache by surface AND source material: exporters may share one material across
 * several meshes. Both the board preview and mechanical workspace use this path. */
export function prepareBoardPreviewMaterials(model: GLTF) {
  const cache = new Map<string, Map<Material, Material>>();
  const replaced = new Set<Material>();
  // KiCad prefixes these surfaces with the source filename (not always "board").
  // Require the native core + mask + copper family before classifying a surface.
  const names = new Set<string>((model.parser.json.meshes ?? []).map((mesh: { name?: string }) => mesh.name).filter((name: unknown): name is string => typeof name === "string"));
  const surfacesByName = new Map<string, string>();
  for (const name of names) {
    if (!name.endsWith("_PCB")) continue;
    const prefix = name.slice(0, -4);
    if (!names.has(`${prefix}_soldermask`) || !names.has(`${prefix}_copper`)) continue;
    for (const kind of ["PCB", "soldermask", "silkscreen", "copper"]) surfacesByName.set(`${prefix}_${kind}`, `board_${kind}`);
  }
  model.scene.traverse(object => {
    if (!(object instanceof Mesh)) return;
    const index = model.parser.associations.get(object)?.meshes;
    const name: unknown = index === undefined ? undefined : model.parser.json.meshes?.[index]?.name;
    const kind = typeof name === "string" ? surfacesByName.get(name) : undefined;
    if (!kind) return;
    let surfaces = cache.get(kind);
    if (!surfaces) { surfaces = new Map(); cache.set(kind, surfaces); }
    const prepare = (material: Material) => {
      let surface = surfaces.get(material);
      if (!surface) { surface = boardPreviewMaterial(material, kind); surfaces.set(material, surface); }
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
