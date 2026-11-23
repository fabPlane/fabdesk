import { expect, test } from "bun:test";
import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, Texture } from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { componentPreviewMaterial } from "./component-preview-material";
import { prepareBoardPreviewMaterials } from "./board-preview-material";

function source(rgb: [number, number, number]) {
  return new MeshStandardMaterial({ color: new Color().setRGB(...rgb), metalness: 1, roughness: 1 });
}
const usb = "USB-A-SMD_HC-USB3.0-L168-ZP";
test("native USB shell and ESP32 shield are metal, inserts and antenna remain non-metal", () => {
  const shell = source([1, 1, 1]);
  const steel = componentPreviewMaterial(shell, usb, {}) as MeshStandardMaterial;
  expect(steel.metalness).toBe(1); expect(steel.roughness).toBeLessThan(.4);
  expect(shell.roughness).toBe(1);
  const blue = source([.020289, .47932, 1]);
  const insert = componentPreviewMaterial(blue, usb, {}) as MeshStandardMaterial;
  expect(insert.metalness).toBe(0); expect(insert.color.equals(blue.color)).toBe(true);
  const shield = componentPreviewMaterial(source([.114290, .113810, .114837]), "ESP32-WROOM-32E", {}) as MeshStandardMaterial;
  expect(shield.color.equals(steel.color)).toBe(true);
  const antenna = componentPreviewMaterial(source([.021981, .021981, .021981]), "ESP32-WROOM-32E", {}) as MeshStandardMaterial;
  expect(antenna.metalness).toBe(0); expect(antenna.color.r).toBeLessThan(.03);
});
test("preserves authored PBR, textures, transparent and unknown component materials", () => {
  const material = source([1, 1, 1]);
  for (const definition of [undefined, { pbrMetallicRoughness: { metallicFactor: 0 } }, { pbrMetallicRoughness: { roughnessFactor: .7 } }, { extensions: {} }]) {
    expect(componentPreviewMaterial(material, usb, definition)).toBe(material);
  }
  expect(componentPreviewMaterial(material, "CustomHousing", {})).toBe(material);
  const custom = source([.3, .2, .8]);
  expect(componentPreviewMaterial(custom, usb, {})).toBe(custom);
  material.map = new Texture(); expect(componentPreviewMaterial(material, usb, {})).toBe(material);
  material.map = null; material.transparent = true;
  expect(componentPreviewMaterial(material, usb, {})).toBe(material);
});
test("shared CAD colors are cached per model without recoloring unknown white objects", () => {
  const scene = new Group(), original = source([1, 1, 1]);
  const meshes = [usb, usb, "CustomWhiteHousing"].map(() => new Mesh(new BoxGeometry(), original)); scene.add(...meshes);
  const associations = new Map<object, object>(meshes.map((m, i) => [m, { meshes: i }])); associations.set(original, { materials: 0 });
  const model = { scene, parser: { associations, json: { asset: { extras: { generator: "KiCad 10.99" } }, materials: [{}],
    meshes: [usb, usb, "CustomWhiteHousing", "model_PCB", "model_soldermask", "model_copper"].map(name => ({ name })) } } } as unknown as GLTF;
  prepareBoardPreviewMaterials(model);
  expect(meshes[0]!.material).toBe(meshes[1]!.material);
  expect(meshes[0]!.material).not.toBe(original);
  expect(meshes[2]!.material).toBe(original);
  expect(meshes[0]!.userData["nativeBoardSurface"]).toBeUndefined();
});

test("native-looking names in an authored GLB do not opt into the CAD palette", () => {
  const scene = new Group(), original = source([1, 1, 1]), mesh = new Mesh(new BoxGeometry(), original); scene.add(mesh);
  const associations = new Map<object, object>([[mesh, { meshes: 0 }], [original, { materials: 0 }]]);
  const model = { scene, parser: { associations, json: { asset: { generator: "Custom renderer" }, materials: [{}],
    meshes: [usb, "model_PCB", "model_soldermask", "model_copper"].map(name => ({ name })) } } } as unknown as GLTF;
  prepareBoardPreviewMaterials(model);
  expect(mesh.material).toBe(original);
});
