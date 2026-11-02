import { expect, test } from "bun:test";
import { Box3, PerspectiveCamera, Vector3 } from "three";
import { assemblyClipRange, fittedCameraDistance } from "./camera-fit";

test("assembly depth range separates thin PCB layers while keeping all corners visible", () => {
  const box = new Box3(new Vector3(-75, -90, 0), new Vector3(75, 90, 20));
  const camera = new PerspectiveCamera(38, 1, 0.0235, 30785);
  camera.position.set(0, 0, 310);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const quantizedDepth = (z: number) =>
    Math.round(((new Vector3(0, 0, z).project(camera).z + 1) / 2) * (2 ** 24 - 1));
  expect(Math.abs(quantizedDepth(1.6) - quantizedDepth(1.61))).toBeLessThanOrEqual(1);
  for (const distance of [30, 310, 5000])
    for (const direction of [new Vector3(0, 0, 1), new Vector3(1, -1, 1).normalize()]) {
      camera.position.copy(direction).multiplyScalar(distance);
      camera.lookAt(0, 0, 0);
      Object.assign(camera, assemblyClipRange(box, camera.position, camera.quaternion));
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      for (const x of [-75, 75])
        for (const y of [-90, 90])
          for (const z of [0, 20]) {
            const world = new Vector3(x, y, z);
            if (world.clone().applyMatrix4(camera.matrixWorldInverse).z >= -0.01) continue;
            expect(Math.abs(world.project(camera).z)).toBeLessThan(1);
          }
      if (distance === 310)
        expect(Math.abs(quantizedDepth(1.6) - quantizedDepth(1.61))).toBeGreaterThan(100);
    }
});

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
