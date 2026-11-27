import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { LaserCellConfigSchema } from "@fabdesk/laser-cell";
import { laser_cell } from "../src/tools/laser";

// The Laser Controller saves the whole laser config it was given; every field must pass the tool's strict schema.
test("laser_cell configure accepts the complete saved laser config", () => {
  const config = LaserCellConfigSchema.parse({});
  const input = z.object(laser_cell.inputSchema).safeParse({ action: "configure", laser: config.laser, arm: config.arm, safetyConfirmed: false });
  expect(input.success ? "ok" : JSON.stringify(input.error.issues)).toBe("ok");
});
