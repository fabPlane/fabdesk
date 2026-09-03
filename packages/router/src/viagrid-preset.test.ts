import { describe, expect, test } from "bun:test";
import type { RouteRequest } from "@fabdesk/protocol";

import { CapacityAutorouterAdapter, chooseCapacityPreset } from "./adapters/capacity";
import { fixtureSrj } from "./testing/fixture";

const assignableVia = (x: number, y: number, id: string): RouteRequest["srj"]["obstacles"][number] => ({
  type: "via",
  obstacleId: id,
  layers: ["top", "bottom"],
  center: { x, y },
  width: 1,
  height: 1,
  connectedTo: [],
  netIsAssignable: true,
});

describe("capacity presets for prefab blanks", () => {
  test("chooseCapacityPreset picks laser-prefab when assignable vias exist and honours an explicit preset", () => {
    const plain = fixtureSrj();
    expect(chooseCapacityPreset(plain, undefined)).toEqual({ preset: "default", assignable: 0 });
    const withVias = { ...plain, obstacles: [...plain.obstacles, assignableVia(0, 0, "v0"), assignableVia(2, 0, "v1")] };
    expect(chooseCapacityPreset(withVias, undefined)).toEqual({ preset: "laser-prefab", assignable: 2 });
    expect(chooseCapacityPreset(withVias, { preset: "default" }).preset).toBe("default");
    expect(chooseCapacityPreset(plain, { preset: "laser-prefab" }).preset).toBe("laser-prefab");
  });

  test("the laser-prefab solver routes the fixture and never drills a via off the fixed positions", async () => {
    const plain = fixtureSrj();
    const fixed = [assignableVia(-3, 3, "v0"), assignableVia(3, 3, "v1"), assignableVia(-3, -3, "v2"), assignableVia(3, -3, "v3")];
    const srj = { ...plain, obstacles: [...plain.obstacles, ...fixed] };
    const result = await new CapacityAutorouterAdapter().route(
      { runId: "run-viagrid", router: "capacity", srj, timeoutMs: 60_000, minFrameIntervalMs: 0 },
      { onMessage: () => {} },
    );
    expect(result.preset).toBe("laser-prefab");
    expect(result.timedOut).toBe(false);
    expect(result.open).toEqual([]);
    expect(result.stats.viasOnFixed).toBe(result.stats.vias);
    for (const trace of result.traces) {
      for (const point of trace.route) {
        if (point.route_type !== "via") continue;
        expect(fixed.some((f) => Math.hypot(f.center.x - point.x, f.center.y - point.y) <= 0.05)).toBe(true);
      }
    }
    expect(result.detail ?? "").toContain("laser-prefab solver");
  }, 90_000);

  test("the default preset reports assignable vias it ignored", async () => {
    const plain = fixtureSrj();
    const srj = { ...plain, obstacles: [...plain.obstacles, assignableVia(-3, 3, "v0")] };
    const result = await new CapacityAutorouterAdapter().route(
      { runId: "run-default", router: "capacity", srj, timeoutMs: 60_000, minFrameIntervalMs: 0, settings: { preset: "default" } },
      { onMessage: () => {} },
    );
    expect(result.preset).toBe("default");
    expect(result.detail ?? "").toContain("assignable via(s) ignored");
  }, 90_000);
});
