import { describe, expect, test } from "bun:test";
import { explodeOffset, orbitBasis, samplePreset } from "../src/presets";
import { fixtureScene } from "../src/fixture";
import { length, sub } from "../src/math";

const scene = fixtureScene();

describe("camera presets", () => {
  test("orbit turns a full circle and keeps looking at the scene", () => {
    const a = samplePreset("orbit", 0, scene);
    const b = samplePreset("orbit", 0.25, scene);
    const c = samplePreset("orbit", 1, scene);
    expect(a.explode).toBe(0);
    expect(a.cardKind).toBe("none");
    const da = sub(a.camera.eye, a.camera.target);
    const db = sub(b.camera.eye, b.camera.target);
    expect(Math.abs(length(da) - length(db))).toBeLessThan(1e-6);
    expect(Math.abs(da.x * db.x + da.z * db.z)).toBeLessThan(1e-6); // 90°
    expect(Math.abs(a.camera.eye.x - c.camera.eye.x)).toBeLessThan(1e-6);
    expect(Math.abs(a.camera.eye.z - c.camera.eye.z)).toBeLessThan(1e-6);
  });

  test("explode starts open and finishes assembled", () => {
    const start = samplePreset("explode", 0, scene);
    const mid = samplePreset("explode", 0.5, scene);
    const end = samplePreset("explode", 1, scene);
    expect(start.explode).toBeCloseTo(1, 5);
    expect(end.explode).toBeCloseTo(0, 5);
    expect(mid.explode).toBeGreaterThan(0.2);
    expect(mid.explode).toBeLessThan(0.8);
  });

  test("flip moves the camera from above the board to below it", () => {
    const top = samplePreset("flip", 0, scene);
    const bottom = samplePreset("flip", 1, scene);
    expect(top.camera.eye.y).toBeGreaterThan(top.camera.target.y);
    expect(bottom.camera.eye.y).toBeLessThan(bottom.camera.target.y);
  });

  test("push-in shortens the camera radius", () => {
    const far = samplePreset("push_in", 0, scene);
    const near = samplePreset("push_in", 1, scene);
    expect(length(sub(far.camera.eye, far.camera.target))).toBeGreaterThan(
      length(sub(near.camera.eye, near.camera.target)),
    );
  });

  test("review plays title, motion, then specs", () => {
    expect(samplePreset("review", 0.05, scene).cardKind).toBe("title");
    expect(samplePreset("review", 0.3, scene).cardKind).toBe("none");
    expect(samplePreset("review", 0.75, scene).explode).toBeGreaterThan(0);
    expect(samplePreset("review", 0.95, scene).cardKind).toBe("specs");
  });

  test("explode offsets push parts away from the centre", () => {
    const { target } = orbitBasis(scene);
    const board = scene.parts[0]!;
    const lid = scene.parts[1]!;
    const a = explodeOffset(board.centroid, target, 1, 40);
    const b = explodeOffset(lid.centroid, target, 1, 40);
    expect(length(a) + length(b)).toBeGreaterThan(1);
    expect(explodeOffset(board.centroid, target, 0, 40)).toEqual({ x: 0, y: 0, z: 0 });
  });
});
