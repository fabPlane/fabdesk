import { expect, test } from "bun:test";
import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, Texture } from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { boardPreviewMaterial, prepareBoardPreviewMaterials } from "./board-preview-material";

test("native ink occludes the soldermask without changing a shared source material", () => {
  const original = new MeshStandardMaterial({ color: 0xffffff, opacity: .9, transparent: true });
  const ink = boardPreviewMaterial(original, "board_silkscreen");
  expect(ink).not.toBe(original);
  expect(ink.transparent).toBe(false);
  expect(ink.opacity).toBe(1);
  expect(ink.depthTest).toBe(true);
  expect(ink.depthWrite).toBe(true);
  expect(original.transparent).toBe(true);
  expect(original.opacity).toBe(.9);
});

test("imported glass, components, and alpha-textured artwork stay untouched", () => {
  const material = new MeshStandardMaterial({ opacity: .5, transparent: true });
  for (const name of ["glass", "component"]) expect(boardPreviewMaterial(material, name)).toBe(material);
  material.alphaMap = new Texture();
  for (const name of ["board_silkscreen", "board_soldermask", "board_PCB", "board_copper"]) expect(boardPreviewMaterial(material, name)).toBe(material);
});

test("default KiCad mask becomes satin green without mutating shared source data", () => {
  const original = new MeshStandardMaterial({ color: new Color().setRGB(.08, .2, .14), opacity: .83, transparent: true });
  const mask = boardPreviewMaterial(original, "board_soldermask") as MeshStandardMaterial;
  expect(mask.color.getHex()).toBe(0x12643b);
  expect(mask.metalness).toBe(0);
  expect(mask.roughness).toBe(.5);
  expect(mask.opacity).toBe(.95);
  expect(mask.transparent).toBe(true);
  expect(mask.forceSinglePass).toBe(true);
  expect(original.color.g).toBe(.2);
  expect(original.opacity).toBe(.83);
});

test("custom board colors, opacity, and authored textures are retained", () => {
  for (const color of [0x183faa, 0x9f2020, 0x151515, 0xffffff, 0x0a9b48]) {
    const original = new MeshStandardMaterial({ color, opacity: .7, transparent: true });
    const mask = boardPreviewMaterial(original, "board_soldermask") as MeshStandardMaterial;
    expect(mask.color.getHex()).toBe(color);
    expect(mask.opacity).toBe(.7);
    expect(mask.side).toBe(original.side);
  }
  const textured = new MeshStandardMaterial({ map: new Texture() });
  expect(boardPreviewMaterial(textured, "board_soldermask")).toBe(textured);
  const colored = new MeshStandardMaterial({ vertexColors: true });
  expect(boardPreviewMaterial(colored, "board_PCB")).toBe(colored);
});

test("native surface clones are reused by kind and keep component selection/geometry intact", () => {
  const scene = new Group();
  const source = new MeshStandardMaterial({ opacity: .9, transparent: true });
  const geometry = new BoxGeometry();
  const meshes = [0,1,2,3].map(() => new Mesh(geometry, source));
  scene.add(...meshes);
  meshes[0]!.name = "U1";
  meshes[0]!.position.set(1, 2, 3);
  const names = ["board_silkscreen", "board_silkscreen", "board_soldermask", "component"];
  const model = {scene, parser:{associations:new Map(meshes.map((m,i)=>[m,{meshes:i}])),json:{meshes:names.map(name=>({name}))}}} as unknown as GLTF;
  let disposed = 0;
  source.addEventListener("dispose",()=>disposed++);
  prepareBoardPreviewMaterials(model);
  expect(meshes[0]!.material).toBe(meshes[1]!.material);
  expect(meshes[0]!.material).not.toBe(meshes[2]!.material);
  expect(meshes[0]!.material.transparent).toBe(false);
  expect(meshes[2]!.material.transparent).toBe(true);
  expect(meshes[3]!.material).toBe(source);
  expect(disposed).toBe(0); // The component still owns the original material.
  expect(meshes[0]!.name).toBe("U1");
  expect(meshes[0]!.position.toArray()).toEqual([1,2,3]);
  expect(meshes.every(m=>m.geometry===geometry)).toBe(true);
});

test("unreferenced originals are disposed once, including multi-material meshes", () => {
  const scene = new Group(), material = new MeshStandardMaterial();
  const mesh = new Mesh(new BoxGeometry(), [material, material]); scene.add(mesh);
  let disposed = 0; material.addEventListener("dispose",()=>disposed++);
  prepareBoardPreviewMaterials({scene, parser:{associations:new Map([[mesh,{meshes:0}]]),json:{meshes:[{name:"board_silkscreen"}]}}} as unknown as GLTF);
  expect(disposed).toBe(1);
  expect(mesh.material[0]!).toBe(mesh.material[1]!);
});
