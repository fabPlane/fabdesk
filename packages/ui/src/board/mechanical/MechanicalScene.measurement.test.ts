import { expect, test } from "bun:test";
import * as T from "three";
import { MechanicalScene } from "./MechanicalScene";
import { MeasurementOverlay } from "./measurement-overlay";

function harness(completed: boolean) {
  const start = new T.Vector3(20, 40, 2);
  const end = new T.Vector3(23, 44, 14);
  const overlay = new MeasurementOverlay(start, completed ? end : undefined);
  const stage = new T.Scene();
  stage.add(overlay);
  const reports: Array<number | null> = [completed ? start.distanceTo(end) : null];
  let disposals = 0;
  overlay.addEventListener("dispose", () => disposals++);
  // Real mode and measurement lifecycle methods, without a WebGL context or input devices.
  const scene: MechanicalScene = Object.assign(Object.create(MechanicalScene.prototype), {
    mode: "measure",
    planarPlacement: true,
    point: completed ? null : start,
    measurement: overlay,
    scene: stage,
    selection: "board",
    gizmo: { dragging: false, showX: true, showY: true, showZ: true },
    callbacks: { measured: (distance: number | null) => reports.push(distance) },
    select() {},
  });
  return { scene, stage, overlay, reports, disposals: () => disposals };
}

test("reapplying scene configuration preserves both the first picked point and a completed measurement", () => {
  for (const completed of [false, true]) {
    const state = harness(completed);
    // Designer reapplies these settings when async board sources or design state refresh.
    state.scene.setPlanarPlacement(true);
    state.scene.setMode("measure");
    state.scene.setPlanarPlacement(false);
    state.scene.setMode("measure");
    expect(state.overlay.parent).toBe(state.stage);
    expect(state.overlay.children.length).toBe(completed ? 4 : 1);
    expect(state.disposals()).toBe(0);
    expect(state.reports).toEqual([completed ? 13 : null]);
    // The retained first point must still be available for the next pick.
    expect(
      (state.scene as unknown as { point: T.Vector3 | null }).point?.toArray() ?? null,
    ).toEqual(completed ? null : [20, 40, 2]);
    state.scene.setMode("orbit");
  }
});

test("leaving measurement mode clears the annotation and readout once, then starts a fresh measurement", () => {
  const state = harness(true);
  state.scene.setMode("orbit");
  expect(state.overlay.parent).toBeNull();
  expect(state.overlay.children).toHaveLength(0);
  expect(state.disposals()).toBe(1);
  expect(state.reports).toEqual([13, null]);
  state.scene.setMode("orbit");
  state.scene.setPlanarPlacement(false);
  expect(state.reports).toEqual([13, null]);
  state.scene.setMode("measure");
  const internals = state.scene as unknown as {
    point: T.Vector3 | null;
    measurement: MeasurementOverlay | null;
  };
  expect(internals.point).toBeNull();
  expect(internals.measurement).toBeNull();
  expect(state.disposals()).toBe(1);
});
