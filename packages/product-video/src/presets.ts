import { aabbCenter, aabbSize, easeInOut, length, lerp, lerpNum, saturate, vec3, type Vec3 } from "./math";
import type { CameraState, FramePose, ProductScene, VideoPreset } from "./types";

const FOV = Math.PI / 4;
const UP = vec3(0, 1, 0);

export type OrbitBasis = {
  target: Vec3;
  radius: number;
  height: number;
};

/** Fit an orbit so the AABB fills most of the frame with a little headroom. */
export function orbitBasis(scene: ProductScene): OrbitBasis {
  const size = aabbSize(scene.bounds);
  const target = aabbCenter(scene.bounds);
  const span = Math.max(size.x, size.y, size.z, 1);
  return { target, radius: span * 1.55, height: span * 0.35 };
}

function cameraAt(azimuth: number, elevation: number, radius: number, target: Vec3): CameraState {
  const ce = Math.cos(elevation);
  const eye = vec3(
    target.x + Math.cos(azimuth) * ce * radius,
    target.y + Math.sin(elevation) * radius,
    target.z + Math.sin(azimuth) * ce * radius,
  );
  return { eye, target, up: UP, fovY: FOV };
}

function pose(camera: CameraState, explode: number, card: FramePose["cardKind"] = "none", cardAmt = 0): FramePose {
  return { camera, explode, card: cardAmt, cardKind: card };
}

/**
 * Sample a camera / explode / title-card pose at `t` in [0, 1].
 * Deterministic for the same scene bounds.
 */
export function samplePreset(preset: VideoPreset, tRaw: number, scene: ProductScene): FramePose {
  const t = saturate(tRaw);
  const { target, radius, height } = orbitBasis(scene);
  const elev = Math.atan2(height, radius);

  switch (preset) {
    case "orbit":
      return pose(cameraAt(t * Math.PI * 2, elev, radius, target), 0);
    case "explode":
      return pose(cameraAt(t * 0.35, elev + 0.18, radius * 1.55, target), 1 - easeInOut(t));
    case "flip": {
      const elevation = lerpNum(Math.PI / 2 - 0.08, -Math.PI / 2 + 0.08, easeInOut(t));
      return pose(cameraAt(0.15, elevation, radius * 1.05, target), 0);
    }
    case "push_in": {
      const r = lerpNum(radius * 1.35, radius * 0.55, easeInOut(t));
      return pose(cameraAt(0.55, elev * 0.7, r, target), 0);
    }
    case "review":
      return sampleReview(t, target, radius, elev);
  }
}

function sampleReview(t: number, target: Vec3, radius: number, elev: number): FramePose {
  // 0–12% title, 12–48% orbit, 48–68% flip, 68–88% explode→assemble, 88–100% specs.
  if (t < 0.12) {
    const u = t / 0.12;
    return pose(cameraAt(-0.4, elev, radius, target), 0, "title", u < 0.15 ? u / 0.15 : u > 0.85 ? (1 - u) / 0.15 : 1);
  }
  if (t < 0.48) {
    const u = (t - 0.12) / 0.36;
    return pose(cameraAt(u * Math.PI * 2 - 0.4, elev, radius, target), 0);
  }
  if (t < 0.68) {
    const u = easeInOut((t - 0.48) / 0.2);
    const elevation = lerpNum(elev, -Math.PI / 2 + 0.1, u);
    return pose(cameraAt(Math.PI * 2 - 0.4, elevation, radius * 1.05, target), 0);
  }
  if (t < 0.88) {
    const u = (t - 0.68) / 0.2;
    return pose(cameraAt(-0.55, elev + 0.18, radius * 1.5, target), 1 - easeInOut(u));
  }
  const u = (t - 0.88) / 0.12;
  return pose(cameraAt(-0.55, elev, radius, target), 0, "specs", u < 0.2 ? u / 0.2 : 1);
}

/** World-space offset for a part at the given explode amount. */
export function explodeOffset(partCentroid: Vec3, sceneCenter: Vec3, explode: number, span: number): Vec3 {
  if (explode <= 1e-6) return vec3(0, 0, 0);
  const delta = {
    x: partCentroid.x - sceneCenter.x,
    y: partCentroid.y - sceneCenter.y,
    z: partCentroid.z - sceneCenter.z,
  };
  const n = length(delta);
  const dir = n < 1e-6 ? vec3(0, 1, 0) : { x: delta.x / n, y: delta.y / n, z: delta.z / n };
  return { x: dir.x * span * 0.28 * explode, y: dir.y * span * 0.28 * explode, z: dir.z * span * 0.28 * explode };
}
