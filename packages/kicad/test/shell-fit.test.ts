import { expect, test } from "bun:test";
import type { MechanicalBox, MechanicalDesign } from "@fabdesk/protocol";
import {
  readStlTriangles,
  ShellSurface,
  triangleIntersectsBox,
  withShellSurfaceReview,
} from "../src/shell-fit";
import { extractBoardFeatures } from "../src/board-features";
import { checkMechanicalFit } from "../src/mechanical-fit";

const box: MechanicalBox = { name: "part", x: 0, y: 0, z: 0, width: 1, depth: 1, height: 1 };
const triangle = [0, 0, 0.5, 2, 0, 0.5, 0, 2, 0.5];
const ascii = (v: number[]) =>
  new TextEncoder().encode(
    `solid case\nfacet normal 0 0 1\nouter loop\n${[0, 3, 6].map((i) => `vertex ${v.slice(i, i + 3).join(" ")}`).join("\n")}\nendloop\nendfacet\nendsolid case`,
  );
function binary(v: number[]) {
  const bytes = new Uint8Array(134);
  bytes.set(new TextEncoder().encode("solid is a valid binary header"));
  const view = new DataView(bytes.buffer);
  view.setUint32(80, 1, true);
  v.forEach((n, i) => view.setFloat32(96 + i * 4, n, true));
  return bytes;
}
test("SAT distinguishes triangle contact from merely overlapping bounding boxes", () => {
  expect(triangleIntersectsBox(triangle, 0, box)).toBe(true);
  expect(triangleIntersectsBox([0, 0, 1, 2, 0, 1, 0, 2, 1], 0, box)).toBe(true);
  expect(triangleIntersectsBox([0, 0, 1.1, 2, 0, 1.1, 0, 2, 1.1], 0, box)).toBe(false);
  // The triangle's AABB intersects the box at its upper corner, but the diagonal does not.
  expect(triangleIntersectsBox([0.9, 2, 0.5, 2, 0.9, 0.5, 2, 2, 0.5], 0, box)).toBe(false);
  expect(
    triangleIntersectsBox([-2, -2, 0, -1, -2, 0, -2, -1, 0], 0, { ...box, x: -2, y: -2, z: -0.5 }),
  ).toBe(true);
});
test("binary and ASCII STL preserve coordinates, including sliced byte buffers", () => {
  expect([...readStlTriangles(ascii(triangle))]).toEqual(triangle);
  expect([...readStlTriangles(binary(triangle))]).toEqual(triangle);
  const padded = new Uint8Array(200);
  padded.set(binary(triangle), 17);
  expect([...readStlTriangles(padded.subarray(17, 151))]).toEqual(triangle);
});
test("invalid, truncated, non-finite, empty and degenerate meshes fail explicitly", () => {
  for (const input of [
    new Uint8Array(),
    binary(triangle).slice(0, 130),
    ascii([NaN, ...triangle.slice(1)]),
    new TextEncoder().encode("solid empty\nendsolid empty"),
  ])
    expect(() => readStlTriangles(input)).toThrow();
  const invalid = binary(triangle);
  new DataView(invalid.buffer).setFloat32(96, Infinity, true);
  expect(() => readStlTriangles(invalid)).toThrow("invalid coordinates");
  expect(() => new ShellSurface(Float64Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]))).toThrow(
    "no usable",
  );
  const mixed = new ShellSurface(Float64Array.from([...triangle, 0, 0, 0, 1, 1, 1, 2, 2, 2]));
  expect(mixed.degenerateTriangles).toBe(1);
  expect(mixed.intersects(box)).toBe(true);
});
test("source transforms match XYZ Euler, scale and translation before collision checking", () => {
  const transform = {
    path: "case.stl",
    scale: 2,
    position: [10, 20, 30] as [number, number, number],
    rotation: [90, 90, 90] as [number, number, number],
  };
  const surface = new ShellSurface(Float64Array.from([1, 2, 3, 2, 2, 3, 1, 3, 3]), transform);
  expect(surface.vertices[0]).toBeCloseTo(16);
  expect(surface.vertices[1]).toBeCloseTo(16);
  expect(surface.vertices[2]).toBeCloseTo(32);
  expect(surface.intersects({ ...box, x: 15.5, y: 15.5, z: 31.5 })).toBe(true);
  expect(surface.intersects(box)).toBe(false);
  expect(() => new ShellSurface(Float64Array.from(triangle), { ...transform, scale: 0 })).toThrow();
  expect(() => surface.intersects(box, { remaining: 0 })).toThrow("complexity limit");
});
test("surface and clearance findings are conservative reviews with world-space highlights", () => {
  const design: MechanicalDesign = {
    version: 1,
    mode: "imported",
    source: { path: "case.stl", scale: 1, position: [0, 0, 0], rotation: [0, 0, 0] },
    confirmed: true,
    space: {
      x: -2,
      y: -2,
      width: 44,
      depth: 24,
      height: 20,
      wall: 2,
      floor: 2,
      lid: 2,
      clearance: 1,
    },
    boards: [{ path: "board.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 }],
    mounts: [],
    openings: [],
    obstacles: [],
  };
  const boards = [
    {
      placement: design.boards[0]!,
      features: extractBoardFeatures(
        '(kicad_pcb (general (thickness 1.6))(gr_rect (start 0 0)(end 40 20)(layer "Edge.Cuts")))',
      ),
    },
  ];
  const baseline = checkMechanicalFit(design, boards);
  const plane = (z: number) =>
    new ShellSurface(Float64Array.from([-5, -5, z, 50, -5, z, -5, 50, z]));
  const contact = withShellSurfaceReview(baseline, design, boards, plane(5));
  expect(contact.status).toBe(baseline.status);
  expect(contact.issues.find((i) => i.code === "shell-surface")).toMatchObject({
    severity: "review",
    regions: [{ x: 0, y: 0, z: 5, width: 40, depth: 20, height: 1.6 }],
  });
  expect(contact.issues.some((i) => i.code === "import-coverage")).toBe(false);
  expect(contact.issues.some((i) => i.code === "shell-coverage")).toBe(true);
  const near = withShellSurfaceReview(baseline, design, boards, plane(4.5));
  expect(near.issues.some((i) => i.code === "shell-clearance")).toBe(true);
  expect(near.issues.some((i) => i.code === "shell-surface")).toBe(false);
  const clear = withShellSurfaceReview(baseline, design, boards, plane(3));
  expect(clear.issues.some((i) => ["shell-surface", "shell-clearance"].includes(i.code))).toBe(
    false,
  );
  expect(clear.issues.find((i) => i.code === "shell-coverage")?.message).toContain(
    "does not test enclosed-volume containment",
  );
});
