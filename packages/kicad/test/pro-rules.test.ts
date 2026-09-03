import { describe, expect, test } from "bun:test";
import { applyRulesToKicadPro } from "../src/convert";

const PRO = JSON.stringify({
  board: { design_settings: { rules: { min_clearance: 0.1, min_track_width: 0.1, min_via_diameter: 0.5 } } },
  net_settings: { classes: [{ name: "Default", clearance: 0.1, track_width: 0.1, via_diameter: 0.6, via_drill: 0.3 }] },
});

describe("applyRulesToKicadPro", () => {
  test("writes the board rules into the design rules and every netclass", () => {
    const out = JSON.parse(applyRulesToKicadPro(PRO, { traceWidthMm: 0.2, clearanceMm: 0.2, viaDrillMm: 0.2, viaDiameterMm: 1 })) as {
      board: { design_settings: { rules: Record<string, number> } };
      net_settings: { classes: Array<Record<string, unknown>> };
    };
    expect(out.board.design_settings.rules).toMatchObject({ min_clearance: 0.2, min_track_width: 0.2, min_via_diameter: 1, min_through_hole_diameter: 0.2 });
    expect(out.net_settings.classes[0]).toMatchObject({ name: "Default", clearance: 0.2, track_width: 0.2, via_diameter: 1, via_drill: 0.2 });
  });

  test("touches only the rules that are given and tolerates a bare project file", () => {
    const out = JSON.parse(applyRulesToKicadPro("{}", { clearanceMm: 0.15 })) as { board: { design_settings: { rules: Record<string, number> } } };
    expect(out.board.design_settings.rules).toEqual({ min_clearance: 0.15 });
    const kept = JSON.parse(applyRulesToKicadPro(PRO, { traceWidthMm: 0.25 })) as { net_settings: { classes: Array<Record<string, unknown>> } };
    expect(kept.net_settings.classes[0]).toMatchObject({ clearance: 0.1, track_width: 0.25, via_drill: 0.3 });
  });
});
