import { DoubleSide, MeshStandardMaterial } from "three";

/** Display finish for untextured STL/OBJ solids, never a manufacturing/material
 * claim. Object-space micrograin needs no UVs, downloaded textures or extra pass.
 * Authored GLB materials are left intact by callers. */
export function enclosurePreviewMaterial() {
  const material = new MeshStandardMaterial({
    color: 0xb7bfc5,
    roughness: .42,
    metalness: .85,
    envMapIntensity: .85,
    side: DoubleSide,
  });
  material.name = "Preview satin aluminum";
  material.customProgramCacheKey = () => "fabdesk-satin-aluminum-v1";
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", "#include <common>\nvarying vec3 vEnclosurePosition;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvEnclosurePosition = position;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", `#include <common>
varying vec3 vEnclosurePosition;
float enclosureGrain(vec3 p) {
  vec3 cell = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  // Smooth, deterministic 3D grain: stable while orbiting, including STL walls.
  vec3 h = vec3(127.1, 311.7, 74.7);
  float n = dot(cell, h);
  return mix(mix(mix(fract(sin(n)*43758.5453), fract(sin(n+h.x)*43758.5453), f.x),
                 mix(fract(sin(n+h.y)*43758.5453), fract(sin(n+h.x+h.y)*43758.5453), f.x), f.y),
             mix(mix(fract(sin(n+h.z)*43758.5453), fract(sin(n+h.x+h.z)*43758.5453), f.x),
                 mix(fract(sin(n+h.y+h.z)*43758.5453), fract(sin(n+h.x+h.y+h.z)*43758.5453), f.x), f.y), f.z);
}`)
      .replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
vec3 grainPosition = vEnclosurePosition * 7.0;
float footprint = max(max(fwidth(grainPosition.x), fwidth(grainPosition.y)), fwidth(grainPosition.z));
float grainWeight = 1.0 - smoothstep(0.35, 1.0, footprint);
if (grainWeight > 0.0) roughnessFactor += (enclosureGrain(grainPosition) - 0.5) * 0.075 * grainWeight;
`);
  };
  return material;
}
