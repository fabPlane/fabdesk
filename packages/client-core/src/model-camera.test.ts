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


test("component close-ups fill the viewport from the actual orbit angle, including tiny parts and vertical views", () => {
  for (const size of [{ x: 20, y: 3, z: 6 }, { x: .1, y: .04, z: .06 }])
    for (const direction of [{ x: 1, y: .2, z: .1 }, { x: -.3, y: 1, z: -.8 }, { x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }])
      for (const aspect of [.5, 3]) {
        const fit = fitModelCamera(size, 38, aspect, .8, direction), tanY = Math.tan(19 * Math.PI / 180);
        const length = Math.hypot(direction.x, direction.y, direction.z);
        expect(fit.direction.x).toBeCloseTo(direction.x / length, 8);
        expect(fit.direction.y).toBeCloseTo(direction.y / length, 8);
        expect(fit.direction.z).toBeCloseTo(direction.z / length, 8);
        let edge = 0;
        for (const x of [-size.x / 2, size.x / 2]) for (const y of [-size.y / 2, size.y / 2]) for (const z of [-size.z / 2, size.z / 2]) {
          const depth = fit.distance - (x * fit.direction.x + y * fit.direction.y + z * fit.direction.z);
          const px = Math.abs(x * fit.right.x + y * fit.right.y + z * fit.right.z) / (depth * tanY * aspect);
          const py = Math.abs(x * fit.up.x + y * fit.up.y + z * fit.up.z) / (depth * tanY);
          expect(depth).toBeGreaterThan(0); expect(px).toBeLessThanOrEqual(.80000001); expect(py).toBeLessThanOrEqual(.80000001);
          edge = Math.max(edge, px, py);
        }
        expect(edge).toBeCloseTo(.8, 8);
      }
  expect(() => fitModelCamera({ x: 1, y: 1, z: 1 }, 38, 1, .8, { x: 0, y: 0, z: 0 })).toThrow();
  expect(() => fitModelCamera({ x: 1, y: 1, z: 1 }, 38, 1, .8, { x: NaN, y: 1, z: 1 })).toThrow();
});
