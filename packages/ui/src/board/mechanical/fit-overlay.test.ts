import { expect, test } from "bun:test";
import { Box3, InstancedMesh, LineSegments, Vector3 } from "three";
import { createFitOverlay } from "./fit-overlay";

test("risk overlays retain world coordinates, deduplicate and remain visible behind a case", () => {
  const region = { name: "J1", x: -12, y: 20, z: -4, width: 3, depth: 5, height: 7 };
  const overlay = createFitOverlay([region, { ...region, name: "duplicate" }]);
  expect(overlay.userData["regionCount"]).toBe(1);
  const bounds = new Box3().setFromObject(overlay);
  expect(bounds.min.toArray()).toEqual([-12, 20, -4]);
  expect(bounds.getSize(new Vector3()).toArray()).toEqual([3, 5, 7]);
  const fill = overlay.children[0] as InstancedMesh;
  expect(fill.count).toBe(1);
  const material = Array.isArray(fill.material) ? fill.material[0]! : fill.material;
  expect(material.depthTest).toBe(false);
  expect(material.depthWrite).toBe(false);
  expect(overlay.children[1]).toBeInstanceOf(LineSegments);
});
test("many risk regions share two drawing objects and invalid volumes are ignored", () => {
  const regions = Array.from({ length: 2000 }, (_, i) => ({
    name: `part-${i}`,
    x: i,
    y: 0,
    z: 0,
    width: 1,
    depth: 2,
    height: 3,
  }));
  const overlay = createFitOverlay([
    ...regions,
    { ...regions[0]!, x: NaN },
    { ...regions[0]!, width: 0 },
  ]);
  expect(overlay.children.length).toBe(2);
  expect((overlay.children[0] as InstancedMesh).count).toBe(2000);
  expect(createFitOverlay([]).children.length).toBe(0);
});
