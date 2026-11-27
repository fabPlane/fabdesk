import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { LaserCellConfigSchema, MATERIAL_PRESETS } from "@fabdesk/laser-cell";
import { laser_cell } from "../src/tools/laser";

// The Laser Controller saves the whole laser config it was given; every field must pass the tool's strict schema.
test("laser_cell configure accepts the complete saved laser config", () => {
  const config = LaserCellConfigSchema.parse({});
  const input = z.object(laser_cell.inputSchema).safeParse({ action: "configure", laser: config.laser, arm: config.arm, safetyConfirmed: false });
  expect(input.success ? "ok" : JSON.stringify(input.error.issues)).toBe("ok");
});

// The job editor (fabPlane USB / Wi-Fi driver) sends presets as they are, positions, null for "none", and drawings.
test("laser_cell accepts what the job editor sends", () => {
  const schema = z.object(laser_cell.inputSchema);
  const ok = (args: Record<string, unknown>) => { const r = schema.safeParse(args); return r.success ? "ok" : JSON.stringify(r.error.issues); };
  for (const preset of MATERIAL_PRESETS) {
    expect(ok({ action: "job_update", settings: preset.settings, edge: preset.edge ?? null })).toBe("ok");
  }
  expect(ok({ action: "job_update", positionMm: { x: -12.5, y: 3 } })).toBe("ok");
  expect(ok({ action: "job_update", positionMm: null })).toBe("ok");
  expect(ok({ action: "import_art", fileName: "logo.svg", format: "svg", text: "<svg/>", widthMm: 25, rotateDeg: 90, mirror: true })).toBe("ok");
  expect(ok({ action: "pause" })).toBe("ok");
  expect(ok({ action: "job_update", settings: { ...MATERIAL_PRESETS[0]!.settings, powerPct: 150 } })).not.toBe("ok");
});
