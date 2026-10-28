import { expect, test } from "bun:test";
import { artImageName, artImageSize } from "./art-image-export";

test("image output follows board proportions and caps large canvas allocations", () => {
  expect(artImageSize(80, 50)).toEqual({ width: 945, height: 591 });
  expect(artImageSize(500, 250)).toEqual({ width: 4096, height: 2048 });
  expect(artImageSize(250, 500)).toEqual({ width: 2048, height: 4096 });
});

test("image downloads are named after the source without project directories", () => {
  expect(artImageName("sketches/my.art.jpeg")).toBe("my.art-board.png");
  expect(artImageName(null)).toBe("art-board.png");
});
