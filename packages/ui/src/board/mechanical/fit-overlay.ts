import * as T from "three";
import type { MechanicalBox } from "@fabdesk/protocol";

/** World-space conservative envelopes, batched so large boards do not add a draw per part. */
export function createFitOverlay(regions: MechanicalBox[]) {
  const unique = new Map<string, MechanicalBox>();
  for (const r of regions) {
    const numbers = [r.x, r.y, r.z, r.width, r.depth, r.height];
    if (!numbers.every(Number.isFinite) || r.width <= 0 || r.depth <= 0 || r.height <= 0) continue;
    unique.set(numbers.join(","), r);
  }
  const boxes = [...unique.values()];
  const group = new T.Group();
  group.name = "fit-risk-overlay";
  group.userData["regionCount"] = boxes.length;
  if (!boxes.length) return group;
  const geometry = new T.BoxGeometry(1, 1, 1);
  const fill = new T.InstancedMesh(
    geometry,
    new T.MeshBasicMaterial({
      color: 0xf34b42,
      transparent: true,
      opacity: 0.24,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
    boxes.length,
  );
  fill.renderOrder = 20;
  const edgeTemplate = new T.EdgesGeometry(geometry);
  const edge = edgeTemplate.getAttribute("position");
  const vertices = new Float32Array(boxes.length * edge.count * 3);
  boxes.forEach((r, i) => {
    const x = r.x + r.width / 2,
      y = r.y + r.depth / 2,
      z = r.z + r.height / 2;
    fill.setMatrixAt(i, new T.Matrix4().makeScale(r.width, r.depth, r.height).setPosition(x, y, z));
    for (let j = 0; j < edge.count; j++) {
      const at = (i * edge.count + j) * 3;
      vertices[at] = x + edge.getX(j) * r.width;
      vertices[at + 1] = y + edge.getY(j) * r.depth;
      vertices[at + 2] = z + edge.getZ(j) * r.height;
    }
  });
  edgeTemplate.dispose();
  fill.instanceMatrix.needsUpdate = true;
  fill.computeBoundingBox();
  fill.computeBoundingSphere();
  const edges = new T.LineSegments(
    new T.BufferGeometry().setAttribute("position", new T.BufferAttribute(vertices, 3)),
    new T.LineBasicMaterial({
      color: 0xff584e,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  edges.renderOrder = 21;
  group.add(fill, edges);
  return group;
}
