import { expect, test } from "bun:test";
import { bindMarkupWebglCanvas, presentMarkupWebglCanvas, unbindMarkupWebglCanvas } from "./webgl";

test("presentMarkupWebglCanvas forces the bound renderer before capture", () => {
  const canvas = {} as HTMLCanvasElement;
  let draws = 0;
  bindMarkupWebglCanvas(canvas, () => {
    draws += 1;
  });
  presentMarkupWebglCanvas(canvas);
  expect(draws).toBe(1);
  unbindMarkupWebglCanvas(canvas);
  presentMarkupWebglCanvas(canvas);
  expect(draws).toBe(1);
});
