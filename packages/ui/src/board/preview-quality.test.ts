import {expect, test} from "bun:test";
import {previewPixelRatio} from "./preview-quality";

test("4K/Retina rendering is bounded without stretching the aspect ratio", () => {
  for (const [width,height] of [[3840,2160],[7680,4320],[600,1600]] as const) {
    const idle = previewPixelRatio(width,height,3);
    const moving = previewPixelRatio(width,height,3,true);
    expect(width*height*idle*idle).toBeLessThanOrEqual(4_000_001);
    expect(width*height*moving*moving).toBeLessThanOrEqual(1_500_001);
    expect(moving).toBeLessThan(idle);
  }
});

test("inspection restores crisp pixels and does not supersample low-DPI displays", () => {
  expect(previewPixelRatio(800,600,2)).toBe(2);
  expect(previewPixelRatio(800,600,2,true)).toBe(1.25);
  expect(previewPixelRatio(800,600,1)).toBe(1);
  expect(previewPixelRatio(800,600,.8)).toBe(.8);
  expect(previewPixelRatio(0,0,2)).toBe(1);
  expect(previewPixelRatio(800,600,NaN)).toBe(1);
});
