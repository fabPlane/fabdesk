import { expect, test } from "bun:test";
import { fitModelCamera } from "./model-camera";

test("fit contains every projected corner for flat boards, tall cases and narrow/wide viewports", () => {
  for (const size of [{ x: 36, y: 1.6, z: 27.455 }, { x: 10, y: 100, z: 4 }, { x: 15, y: 0, z: 15 }]) for (const aspect of [.4, 1, 3]) {
    const fit = fitModelCamera(size, 38, aspect), tanY = Math.tan(19 * Math.PI / 180);
    let edge = 0;
    for (const x of [-size.x / 2, size.x / 2]) for (const y of [-size.y / 2, size.y / 2]) for (const z of [-size.z / 2, size.z / 2]) {
      const depth = fit.distance - (x * fit.direction.x + y * fit.direction.y + z * fit.direction.z);
      const projectedX = Math.abs(x * fit.right.x + y * fit.right.y + z * fit.right.z) / (depth * tanY * aspect), projectedY = Math.abs(x * fit.up.x + y * fit.up.y + z * fit.up.z) / (depth * tanY);
      expect(depth).toBeGreaterThan(0); expect(projectedX).toBeLessThanOrEqual(.80000001); expect(projectedY).toBeLessThanOrEqual(.80000001); edge = Math.max(edge, projectedX, projectedY);
    }
    expect(edge).toBeCloseTo(.8, 8);
  }
});
test("invalid sizes/viewports cannot produce an infinite or empty camera", () => {
  for (const args of [[0, 0, 0, 38, 1], [10, -1, 2, 38, 1], [10, 2, 1, 0, 1], [10, 2, 1, 180, 1], [10, 2, 1, 38, 0], [NaN, 2, 1, 38, 1]]) expect(() => fitModelCamera({ x: args[0]!, y: args[1]!, z: args[2]! }, args[3]!, args[4]!)).toThrow();
});
