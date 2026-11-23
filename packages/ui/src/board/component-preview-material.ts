import { Color, Material, MeshStandardMaterial, Texture } from "three";

type Finish = { color?: number; metalness: number; roughness: number };
const nickel: Finish = { color: 0xc5cbd0, metalness: 1, roughness: .27 };
const tin: Finish = { color: 0xbfc3c7, metalness: 1, roughness: .32 };
const gold: Finish = { color: 0xd9b66f, metalness: 1, roughness: .3 };
const resin: Finish = { metalness: 0, roughness: .68 };
const ceramic: Finish = { metalness: 0, roughness: .8 };
function matches(color: Color, rgb: readonly number[]) {
  return [color.r, color.g, color.b].every((value, i) => Math.abs(value - rgb[i]!) < .0001);
}

/** STEP exports provide diffuse CAD colors, not authored PBR. Recognize only
 * known model/palette pairs. In particular, gray is not universally metal and
 * white is not universally a connector shell. Values here are linear RGB. */
function finishFor(name: string, color: Color): Finish | undefined {
  const usb = /^(USB[-_]A|USB_C_Receptacle)/.test(name);
  const esp = /^ESP32-WROOM-32(?:E|UE|D|U)?$/.test(name);
  if (name === "USB-A-SMD_HC-USB3.0-L168-ZP") {
    if (matches(color, [1, 1, 1]) || matches(color, [.527115, .527115, .527115])) return nickel;
    if (matches(color, [1, 1, 0])) return gold;
    if (matches(color, [.020289, .47932, 1]) || matches(color, [0, 0, 0])) return resin;
  }
  if (esp && matches(color, [.114290, .113810, .114837])) return nickel;
  // KiCad library STEP palette: solder terminals, gold plating, epoxy, ceramic.
  const library = usb || esp || /^(?:R|C|L)_\d|^(?:SOIC|SOT|QFN|TSSOP|LQFP|D_)/.test(name);
  if (!library) return;
  if (matches(color, [.645308, .638283, .572123])) return usb ? nickel : tin;
  if (matches(color, [.708704, .504022, .210357])) return gold;
  if (matches(color, [.060575, .060575, .060575]) || matches(color, [.021981, .021981, .021981]) ||
      matches(color, [.007453, .007986, .009117])) return resin;
  if (matches(color, [.777554, .769720, .626097]) || matches(color, [.118623, .059254, .037972])) return ceramic;
}

/** Called only for a verified native KiCad PCB, using original glTF mesh and
 * material identities. Preserve authored textures, transparency and PBR data. */
export function componentPreviewMaterial(material: Material, meshName: string, definition: {
  pbrMetallicRoughness?: { metallicFactor?: number; roughnessFactor?: number; baseColorTexture?: unknown; metallicRoughnessTexture?: unknown };
  extensions?: unknown;
} | undefined): Material {
  if (!definition || !(material instanceof MeshStandardMaterial) || material.type !== "MeshStandardMaterial" ||
      material.transparent || material.opacity !== 1 || material.vertexColors ||
      Object.values(material).some(value => value instanceof Texture) ||
      definition.extensions || definition.pbrMetallicRoughness?.metallicFactor !== undefined ||
      definition.pbrMetallicRoughness?.roughnessFactor !== undefined ||
      definition.pbrMetallicRoughness?.baseColorTexture || definition.pbrMetallicRoughness?.metallicRoughnessTexture) return material;
  const finish = finishFor(meshName, material.color);
  if (!finish) return material;
  const surface = material.clone();
  if (finish.color !== undefined) surface.color.set(finish.color);
  surface.metalness = finish.metalness;
  surface.roughness = finish.roughness;
  surface.envMapIntensity = finish.metalness ? 1.25 : .35;
  if (finish === nickel) {
    // A subtle rolled finish in model space; no UV requirement, textures,
    // additional passes, or animation. Fade subpixel grain to prevent shimmer.
    surface.customProgramCacheKey = () => "fabdesk-connector-satin-v1";
    surface.onBeforeCompile = shader => {
      shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vConnectorPosition;")
        .replace("#include <begin_vertex>", "#include <begin_vertex>\nvConnectorPosition = position;");
      shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vConnectorPosition;
float connectorNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  vec3 h = vec3(127.1, 311.7, 74.7);
  float n = dot(i, h);
  return mix(mix(mix(fract(sin(n)*43758.5453), fract(sin(n+h.x)*43758.5453), f.x),
    mix(fract(sin(n+h.y)*43758.5453), fract(sin(n+h.x+h.y)*43758.5453), f.x), f.y),
    mix(mix(fract(sin(n+h.z)*43758.5453), fract(sin(n+h.x+h.z)*43758.5453), f.x),
    mix(fract(sin(n+h.y+h.z)*43758.5453), fract(sin(n+h.x+h.y+h.z)*43758.5453), f.x), f.y), f.z);
}`)
        .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
// Native glTF geometry is in metres; the board surface lies in XZ.
vec3 grainPosition = vConnectorPosition * vec3(700.0, 700.0, 8000.0);
vec3 footprint = fwidth(grainPosition);
float grainWeight = 1.0 - smoothstep(0.4, 1.2, max(max(footprint.x, footprint.y), footprint.z));
float grain = (connectorNoise(grainPosition) - 0.5) * grainWeight;
roughnessFactor += grain * 0.14;
diffuseColor.rgb *= 1.0 + grain * 0.12;
`);
    };
  }
  return surface;
}
