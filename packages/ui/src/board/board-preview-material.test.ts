import { expect, test } from "bun:test";
import { MeshStandardMaterial, Texture } from "three";
import { boardPreviewMaterial } from "./board-preview-material";

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

test("soldermask, imported glass, and alpha-textured artwork keep their transparency", () => {
  const material = new MeshStandardMaterial({ opacity: .5, transparent: true });
  for (const name of ["board_soldermask", "glass", "component"]) expect(boardPreviewMaterial(material, name)).toBe(material);
  material.alphaMap = new Texture();
  expect(boardPreviewMaterial(material, "board_silkscreen")).toBe(material);
});
