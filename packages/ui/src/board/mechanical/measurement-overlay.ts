import * as T from "three";
import { Line2 } from "three/addons/lines/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

const ENDPOINT_PIXELS = 16;
const INK = 0x152018;
const ACCENT = 0xffe29a;

/** A dark rim and a bright target remain readable on both the case and a detailed PCB. */
function endpointTexture() {
  const size = 64;
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const radius = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const bright = radius < 21 && radius > 7;
      const color = bright ? ACCENT : INK;
      const offset = (y * size + x) * 4;
      pixels[offset] = (color >> 16) & 255;
      pixels[offset + 1] = (color >> 8) & 255;
      pixels[offset + 2] = color & 255;
      pixels[offset + 3] = Math.round(255 * T.MathUtils.clamp(32 - radius, 0, 1));
    }
  const texture = new T.DataTexture(pixels, size, size);
  texture.colorSpace = T.SRGBColorSpace;
  texture.magFilter = texture.minFilter = T.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Screen-sized measurement annotation. Update only during the scene's existing demand render. */
export class MeasurementOverlay extends T.Group {
  private readonly texture = endpointTexture();
  private readonly endpointMaterial = new T.SpriteMaterial({
    map: this.texture,
    sizeAttenuation: false,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  private readonly endpoints: T.Sprite[] = [];
  private readonly strokes: Line2[] = [];
  private readonly lineGeometry: LineGeometry | null;
  private disposed = false;

  constructor(start: T.Vector3, end?: T.Vector3) {
    super();
    // Annotations deliberately stay visible over solids and fit warnings. Keeping every
    // child transparent also puts both strokes and targets in the same render phase.
    this.renderOrder = 50;
    this.lineGeometry =
      end && start.distanceToSquared(end) > 0
        ? new LineGeometry().setPositions([...start.toArray(), ...end.toArray()])
        : null;
    if (this.lineGeometry)
      for (const [color, linewidth, order] of [
        [INK, 7, 0],
        [ACCENT, 3, 1],
      ] as const) {
        const line = new Line2(
          this.lineGeometry,
          new LineMaterial({
            color,
            linewidth,
            worldUnits: false,
            transparent: true,
            depthTest: false,
            depthWrite: false,
            toneMapped: false,
          }),
        );
        line.renderOrder = order;
        line.frustumCulled = false;
        this.strokes.push(line);
        this.add(line);
      }
    for (const point of end ? [start, end] : [start]) {
      const marker = new T.Sprite(this.endpointMaterial);
      marker.position.copy(point);
      marker.renderOrder = 2;
      marker.frustumCulled = false;
      this.endpoints.push(marker);
      this.add(marker);
    }
  }

  updateViewport(camera: T.PerspectiveCamera, width: number, height: number) {
    if (width <= 0 || height <= 0) return;
    // A non-attenuated sprite's shader cancels camera distance. Compensating for the
    // projection scale keeps its diameter fixed in CSS pixels, including camera zoom.
    const scale = (2 * ENDPOINT_PIXELS) / (height * camera.projectionMatrix.elements[5]!);
    for (const marker of this.endpoints) marker.scale.setScalar(scale);
    for (const line of this.strokes) line.material.resolution.set(width, height);
  }

  override dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lineGeometry?.dispose();
    for (const line of this.strokes) {
      line.material.dispose();
      line.dispose();
    }
    for (const marker of this.endpoints) marker.dispose();
    this.endpointMaterial.dispose();
    this.texture.dispose();
    // Sprite geometry is shared by Three across the entire app, so it is not ours to dispose.
    this.clear();
    super.dispose();
  }
}
