import { expect, test } from "bun:test";
import {
  enclosureBoardPose,
  enclosureBoardPlacement,
  centerEnclosureBoard,
  defaultEnclosureDesign,
} from "./enclosure-design";
const outline = { minX: 100, minY: 50, maxX: 152, maxY: 74, widthMm: 52, heightMm: 24 };
test("centre-mounted gizmos preserve native board coordinates across rotations", () => {
  for (const rotation of [0, 45, 90, -90, 180]) {
    const original = { path: "board.kicad_pcb", x: 12, y: -7, z: 5, rotation };
    const pose = enclosureBoardPose(original, outline);
    expect(pose.origin).toEqual([126, 62, 0]);
    const roundtrip = enclosureBoardPlacement(original, outline, pose.position, rotation);
    expect(roundtrip.x).toBeCloseTo(original.x);
    expect(roundtrip.y).toBeCloseTo(original.y);
    expect(roundtrip.z).toBe(original.z);
  }
});
test("drag and centre preserve height and orientation without mutating source placement", () => {
  const original = { path: "board.kicad_pcb", x: 0, y: 0, z: 5, rotation: 90 };
  const p = enclosureBoardPose(original, outline).position;
  const moved = enclosureBoardPlacement(original, outline, [p[0] + 9, p[1] - 3, p[2] + 2], 90);
  expect(moved.x).toBeCloseTo(9);
  expect(moved.y).toBeCloseTo(-3);
  expect(moved.z).toBe(7);
  const space = defaultEnclosureDesign(null).space;
  const centered = centerEnclosureBoard(original, outline, space);
  const c = enclosureBoardPose(centered, outline);
  expect(c.position[0]).toBeCloseTo(space.x + space.width / 2);
  expect(c.position[1]).toBeCloseTo(space.y + space.depth / 2);
  expect(centered.rotation).toBe(90);
  expect(centered.z).toBe(5);
  expect(original.x).toBe(0);
  expect(() => enclosureBoardPlacement(original, outline, [NaN, 0, 0], 0)).toThrow();
});
test("rotating around the displayed centre keeps that centre fixed", () => {
  const original = { path: "board.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 };
  const center = enclosureBoardPose(original, outline).position;
  const turned = enclosureBoardPlacement(original, outline, center, 90);
  enclosureBoardPose(turned, outline).position.forEach((v, i) => expect(v).toBeCloseTo(center[i]!));
});
