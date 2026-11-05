import { expect, test } from "bun:test";
import * as T from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { MeasurementOverlay } from "./measurement-overlay";

/** Project the billboard corners using Three's non-attenuated sprite vertex transform. */
function endpointPixels(marker: T.Sprite, camera: T.PerspectiveCamera, height: number) {
  const center = marker.position.clone().applyMatrix4(camera.matrixWorldInverse);
  const halfHeight = (marker.scale.y * -center.z) / 2;
  const top = center
    .clone()
    .add(new T.Vector3(0, halfHeight, 0))
    .applyMatrix4(camera.projectionMatrix);
  const bottom = center
    .clone()
    .add(new T.Vector3(0, -halfHeight, 0))
    .applyMatrix4(camera.projectionMatrix);
  return (Math.abs(top.y - bottom.y) * height) / 2;
}

test("measurement targets remain 16 CSS pixels when orbiting, zooming and resizing the board view", () => {
  const start = new T.Vector3(4, 7, 3);
  const end = new T.Vector3(29, 17, 11);
  const overlay = new MeasurementOverlay(start, end);
  const markers = overlay.children.filter((child): child is T.Sprite => child instanceof T.Sprite);
  const lines = overlay.children.filter((child): child is Line2 => child instanceof Line2);
  const center = start.clone().add(end).multiplyScalar(0.5);
  for (const [width, height] of [
    [1280, 800],
    [360, 280],
  ] as const)
    for (const direction of [
      new T.Vector3(0, 0, 1),
      new T.Vector3(1, -2, 1),
      new T.Vector3(0, -1, 0),
    ])
      for (const distance of [50, 250, 2500])
        for (const zoom of [0.5, 1, 2]) {
          const camera = new T.PerspectiveCamera(38, width / height, 0.01, 1e6);
          camera.position.copy(direction).normalize().multiplyScalar(distance).add(center);
          camera.lookAt(center);
          camera.zoom = zoom;
          camera.setViewOffset(width, height, -width * 0.12, height * 0.08, width, height);
          camera.updateProjectionMatrix();
          camera.updateMatrixWorld();
          overlay.updateViewport(camera, width, height);
          for (const marker of markers) {
            expect(marker.material.sizeAttenuation).toBe(false);
            expect(endpointPixels(marker, camera, height)).toBeCloseTo(16, 8);
          }
          expect(lines.map((line) => line.material.linewidth)).toEqual([7, 3]);
          for (const line of lines) {
            expect(line.material.worldUnits).toBe(false);
            expect(line.material.resolution.toArray()).toEqual([width, height]);
          }
        }
  expect(markers.map((marker) => marker.position.toArray())).toEqual([
    start.toArray(),
    end.toArray(),
  ]);
  overlay.dispose();
});

test("picking the first point and completing a measurement retain the exact surface coordinates", () => {
  const start = new T.Vector3(20, 40, 2);
  const end = new T.Vector3(23, 44, 14);
  const first = new MeasurementOverlay(start);
  expect(first.children).toHaveLength(1);
  expect(first.children[0]).toBeInstanceOf(T.Sprite);
  expect(first.children[0]!.position.toArray()).toEqual([20, 40, 2]);

  const finished = new MeasurementOverlay(start, end);
  start.set(0, 0, 0);
  end.set(0, 0, 0);
  const line = finished.children.find((child): child is Line2 => child instanceof Line2)!;
  const from = new T.Vector3().fromBufferAttribute(line.geometry.getAttribute("instanceStart"), 0);
  const to = new T.Vector3().fromBufferAttribute(line.geometry.getAttribute("instanceEnd"), 0);
  expect(from.toArray()).toEqual([20, 40, 2]);
  expect(to.toArray()).toEqual([23, 44, 14]);
  expect(from.distanceTo(to)).toBe(13);
  const repeatedPoint = new MeasurementOverlay(start, start);
  expect(repeatedPoint.children.every((child) => child instanceof T.Sprite)).toBe(true);
  for (const overlay of [first, finished, repeatedPoint]) overlay.dispose();
});

function contrast(a: T.Color, b: T.Color) {
  const luminance = (color: T.Color) => color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

test("outlined measurements contrast with dark, light, PCB and red fit surfaces without depth occlusion", () => {
  const overlay = new MeasurementOverlay(new T.Vector3(), new T.Vector3(10, 5, 2));
  const lines = overlay.children.filter((child): child is Line2 => child instanceof Line2);
  const marker = overlay.children.find((child): child is T.Sprite => child instanceof T.Sprite)!;
  for (const background of [0x19211a, 0xeeeeee, 0xbad1c8, 0x148345, 0xef4444]) {
    const surface = new T.Color(background);
    expect(
      Math.max(...lines.map((line) => contrast(line.material.color, surface))),
    ).toBeGreaterThan(3);
  }
  // Endpoints carry the same dark/bright treatment, with a central dot at the picked point.
  const texture = marker.material.map as T.DataTexture;
  const pixels = texture.image.data as Uint8Array;
  const colorAt = (x: number, y: number) =>
    Array.from(pixels.slice((y * 64 + x) * 4, (y * 64 + x) * 4 + 4));
  expect(colorAt(32, 32)).toEqual([21, 32, 24, 255]);
  expect(colorAt(32, 47)).toEqual([255, 226, 154, 255]);
  expect(colorAt(32, 59)).toEqual([21, 32, 24, 255]);
  expect(colorAt(0, 0)[3]).toBe(0);
  expect(overlay.renderOrder).toBeGreaterThan(21);
  for (const child of overlay.children as Array<Line2 | T.Sprite>) {
    expect(child.material.transparent).toBe(true);
    expect(child.material.depthTest).toBe(false);
    expect(child.material.depthWrite).toBe(false);
    expect(child.material.toneMapped).toBe(false);
    expect(child.frustumCulled).toBe(false);
  }
  expect(lines[0]!.renderOrder).toBeLessThan(lines[1]!.renderOrder);
  expect(lines[1]!.renderOrder).toBeLessThan(marker.renderOrder);
  overlay.dispose();
});

test("clearing measurements frees every owned resource once without disposing shared sprite geometry", () => {
  for (const end of [undefined, new T.Vector3(5, 8, 2)]) {
    const overlay = new MeasurementOverlay(new T.Vector3(), end);
    const materials = new Set<T.Material>();
    const geometries = new Set<T.BufferGeometry>();
    let textureDisposals = 0,
      sharedGeometryDisposals = 0;
    let texture: T.Texture | null = null;
    let spriteGeometry: T.BufferGeometry | null = null;
    for (const child of overlay.children) {
      if (child instanceof Line2) {
        materials.add(child.material);
        geometries.add(child.geometry);
      } else if (child instanceof T.Sprite) {
        materials.add(child.material);
        texture = child.material.map;
        spriteGeometry = child.geometry;
      }
    }
    const counts: number[] = [];
    for (const resource of [...materials, ...geometries]) {
      const index = counts.length;
      counts.push(0);
      resource.addEventListener("dispose", () => counts[index]!++);
    }
    texture!.addEventListener("dispose", () => textureDisposals++);
    const sharedDisposed = () => sharedGeometryDisposals++;
    spriteGeometry!.addEventListener("dispose", sharedDisposed);
    overlay.dispose();
    overlay.dispose();
    expect(counts.every((count) => count === 1)).toBe(true);
    expect(textureDisposals).toBe(1);
    expect(sharedGeometryDisposals).toBe(0);
    expect(overlay.children).toHaveLength(0);
    spriteGeometry!.removeEventListener("dispose", sharedDisposed);
  }
});
