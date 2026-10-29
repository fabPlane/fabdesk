import { expect, test } from "bun:test";
import { Box3, PerspectiveCamera, Vector3 } from "three";
import { fittedCameraDistance } from "./camera-fit";

test("fit keeps every corner inside wide, tall and square viewports in different orientations", () => {
  for (const aspect of [0.45, 1, 2.4])
    for (const size of [
      [240, 65, 10],
      [20, 20, 100],
      [50, 50, 2],
    ])
      for (const direction of [
        [1, -1, 1],
        [0, -0.0001, 1],
        [1, 0, 0.001],
      ]) {
        const center = new Vector3(120, -40, 8);
        const box = new Box3().setFromCenterAndSize(center, new Vector3(...size));
        const camera = new PerspectiveCamera(38, aspect, 0.001, 1e6);
        camera.up.set(0, 0, 1);
        const away = new Vector3(...direction).normalize();
        camera.position.copy(center).addScaledVector(away, 500);
        camera.lookAt(center);
        const distance = fittedCameraDistance(box, camera.quaternion, camera.fov, aspect);
        camera.position.copy(center).addScaledVector(away, distance);
        camera.updateMatrixWorld();
        let occupied = 0;
        for (const x of [box.min.x, box.max.x])
          for (const y of [box.min.y, box.max.y])
            for (const z of [box.min.z, box.max.z]) {
              const p = new Vector3(x, y, z).project(camera);
              expect(Math.abs(p.x)).toBeLessThanOrEqual(1 / 1.12 + 1e-8);
              expect(Math.abs(p.y)).toBeLessThanOrEqual(1 / 1.12 + 1e-8);
              expect(Math.abs(p.z)).toBeLessThan(1);
              occupied = Math.max(occupied, Math.abs(p.x), Math.abs(p.y));
            }
        expect(occupied).toBeGreaterThan(0.85);
      }
});
