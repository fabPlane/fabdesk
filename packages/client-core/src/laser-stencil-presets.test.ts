import { expect, test } from "bun:test";
import {
  DEFAULT_LASER_STENCIL_PRESET,
  LASER_STENCIL_PRESET_IDS,
  LASER_STENCIL_UI_PRESETS,
  laserStencilFormDefaults,
  parseLaserNumber,
} from "./laser-stencil-presets";

test("Mylar 0.1 mm is the default laser stencil preset", () => {
  expect(DEFAULT_LASER_STENCIL_PRESET).toBe("mylar-uv");
  expect(LASER_STENCIL_PRESET_IDS).toEqual(["mylar-uv", "kapton", "stainless-0.1"]);
  expect(LASER_STENCIL_UI_PRESETS["mylar-uv"].thicknessMm).toBe(0.1);
  expect(LASER_STENCIL_UI_PRESETS["mylar-uv"].label).toMatch(/Mylar/);
  expect(LASER_STENCIL_UI_PRESETS.kapton.thicknessMm).toBe(0.075);
  expect(LASER_STENCIL_UI_PRESETS["stainless-0.1"].passes).toBe(8);
});

test("form defaults follow the selected catalog row", () => {
  expect(laserStencilFormDefaults("kapton").speedMmPerS).toBe(1600);
  expect(parseLaserNumber("1.25")).toBe(1.25);
  expect(parseLaserNumber("nope")).toBeUndefined();
});
