import { expect, test } from "bun:test";
import {
  DEFAULT_LASER_STENCIL_FORM,
  laserStencilFormFromPreset,
  laserStencilToolArgs,
} from "./LaserStencilPresetPanel";
import { LASER_STENCIL_UI_PRESETS } from "@fabdesk/client-core";

test("Mylar 0.1 mm is the default laser stencil preset", () => {
  expect(DEFAULT_LASER_STENCIL_FORM.preset).toBe("mylar-uv");
  expect(LASER_STENCIL_UI_PRESETS["mylar-uv"].thicknessMm).toBe(0.1);
  expect(LASER_STENCIL_UI_PRESETS["mylar-uv"].label).toMatch(/Mylar/);
  expect(LASER_STENCIL_UI_PRESETS.kapton.thicknessMm).toBe(0.075);
  expect(LASER_STENCIL_UI_PRESETS["stainless-0.1"].passes).toBe(8);
});

test("switching preset reloads starting-point job values", () => {
  const kapton = laserStencilFormFromPreset("kapton");
  expect(kapton.speedMmPerS).toBe("1600");
  expect(kapton.apertureOffsetMm).toBe("0.04");
  expect(laserStencilToolArgs(kapton)).toMatchObject({
    preset: "kapton",
    includeFiducials: true,
    speedMmPerS: 1600,
    apertureOffsetMm: 0.04,
    kerfMm: 0.015,
    powerPct: 100,
    frequencyKhz: 30,
    passes: 2,
  });
});

test("edited starting points are passed through to the export tool", () => {
  const args = laserStencilToolArgs({
    ...DEFAULT_LASER_STENCIL_FORM,
    powerPct: "80",
    speedMmPerS: "900",
    passes: "3",
    includeFiducials: false,
  });
  expect(args).toMatchObject({
    preset: "mylar-uv",
    powerPct: 80,
    speedMmPerS: 900,
    passes: 3,
    includeFiducials: false,
  });
});
