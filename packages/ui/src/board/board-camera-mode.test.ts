import { expect, test } from "bun:test";
import { OrthographicCamera, Vector3 } from "three";
import { alignBoardCamera, restoreBoardCamera } from "./board-camera-mode";

for (const side of ["top", "bottom"] as const) test(`${side} 2D to 3D preserves pan, zoom, direction and projection`, () => {
  const camera = new OrthographicCamera(-80, 80, 50, -50, .01, 1000);
  const target = new Vector3(12, 0, -7);
  camera.position.copy(target).add(new Vector3(0, side === "top" ? 120 : -120, 0));
  camera.up.set(0, 0, -1); camera.zoom = 2.5; camera.updateProjectionMatrix(); camera.lookAt(target);
  const before = camera.toJSON();
  alignBoardCamera(camera, target, { mode: "3d", side }, { mode: "2d", side });
  expect(camera.toJSON()).toEqual(before);
  expect(target.toArray()).toEqual([12, 0, -7]);
});
test("returning from an orbited 3D view flattens the selected side without losing pan or zoom", () => {
  const camera = new OrthographicCamera(-80, 80, 50, -50, .01, 1000), target = new Vector3(12, 0, -7);
  camera.position.set(42, 80, 53); camera.zoom = 3;
  const distance = camera.position.distanceTo(target);
  alignBoardCamera(camera, target, { mode: "2d", side: "bottom" }, { mode: "3d", side: "bottom" });
  expect(camera.position.toArray()).toEqual([12, -distance, -7]);
  expect(camera.zoom).toBe(3);
});
test("opening 3D directly starts above the board", () => {
  const camera = new OrthographicCamera(); camera.position.set(0, 120, 0);
  alignBoardCamera(camera, new Vector3(), { mode: "3d", side: "top" }, null);
  expect(camera.position.toArray()).toEqual([0, 120, 0]);
});

for (const mode of ["2d", "3d"] as const) test(`replacing ${mode} geometry retains the board camera, pan and zoom`, () => {
  const old = new OrthographicCamera(-80, 80, 50, -50, .01, 1000), target = new Vector3(12, 0, -7);
  old.position.set(mode === "3d" ? 42 : 12, 80, mode === "3d" ? 53 : -7);
  old.up.set(0, 0, -1); old.zoom = 2.5; old.updateProjectionMatrix(); old.lookAt(target);
  const view = { mode, side: "top" as const, revision: 2 };
  const saved = { camera: old.clone(), target: target.clone(), view };
  const replacement = new OrthographicCamera(-100, 100, 100, -100, .1, 2000), replacementTarget = new Vector3();
  restoreBoardCamera(replacement, replacementTarget, saved);
  alignBoardCamera(replacement, replacementTarget, view, saved.view);
  expect(replacement.position.toArray()).toEqual(old.position.toArray());
  expect(replacementTarget.toArray()).toEqual(target.toArray());
  expect(replacement.projectionMatrix.elements).toEqual(old.projectionMatrix.elements);
  expect(replacement.zoom).toBe(2.5);
  replacement.position.set(1, 2, 3); replacementTarget.set(0, 0, 0);
  expect(saved.camera.position.toArray()).toEqual(old.position.toArray());
  expect(saved.target.toArray()).toEqual(target.toArray());
});

for (const side of ["top", "bottom"] as const) test(`3D ${side} button resets an orbit even when that side is already selected`, () => {
  const camera = new OrthographicCamera(), target = new Vector3(4, 2, 3);
  camera.position.set(10, 20, 30); camera.zoom = 2;
  const distance = camera.position.distanceTo(target);
  alignBoardCamera(camera, target, { mode: "3d", side, revision: 2 }, { mode: "3d", side, revision: 1 });
  expect(camera.position.toArray()).toEqual([4, 2 + (side === "top" ? distance : -distance), 3]);
  expect(camera.zoom).toBe(2);
});
