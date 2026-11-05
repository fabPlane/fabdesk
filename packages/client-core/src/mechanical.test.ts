import { expect, test } from "bun:test";
import {
  mechanicalItem,
  parseMechanicalLayout,
  validateModelFile,
  MODEL_MAX_BYTES,
  enclosurePose,
} from "./mechanical";
test("case preview follows a rotated and scaled board while preserving its mount height", () => {
  const board = mechanicalItem("renders/board.glb", "board");
  board.position = [20, 30, 40];
  board.rotation = [90, 0, 0];
  board.scale = 2;
  const pose = enclosurePose(board, 5);
  expect(pose.position[0]).toBeCloseTo(20);
  expect(pose.position[1]).toBeCloseTo(40);
  expect(pose.position[2]).toBeCloseTo(40);
  expect(pose.rotation).toEqual(board.rotation);
  expect(board.position).toEqual([20, 30, 40]);
});
test("assembly transforms round-trip without changing source model identities", () => {
  const item = mechanicalItem("cad/imports/case.stl");
  item.position = [12, -5, 3];
  item.rotation = [0, 45, 90];
  item.scale = 25.4;
  item.visible = false;
  expect(parseMechanicalLayout(JSON.stringify({ version: 1, items: [item] })).items).toEqual([
    item,
  ]);
});
test("assembly files reject unsafe paths, duplicate identities and invalid transforms", () => {
  const item = mechanicalItem("cad/imports/case.stl");
  for (const patch of [
    { path: "../secret" },
    { path: "C:/private" },
    { path: "/etc/passwd" },
    { path: "cad\\secret" },
    { scale: 0 },
    { rotation: [0, 0, 1e20] },
    { position: [1, 2] },
  ])
    expect(() =>
      parseMechanicalLayout(JSON.stringify({ version: 1, items: [{ ...item, ...patch }] })),
    ).toThrow();
  expect(() => parseMechanicalLayout(JSON.stringify({ version: 1, items: [item, item] }))).toThrow(
    /Duplicate/,
  );
});
test("long imported file names survive reopening the assembly", () => {
  const item = mechanicalItem(`cad/imports/${"a".repeat(36)}-${"case".repeat(28)}.stl`);
  expect(parseMechanicalLayout(JSON.stringify({ version: 1, items: [item] })).items[0]).toEqual(
    item,
  );
});
test("imports accept only bounded supported model files", () => {
  for (const name of ["case.STL", "board.glb", "part.obj"])
    expect(() => validateModelFile(name, 2048)).not.toThrow();
  for (const [name, size] of [
    ["case.stl", 0],
    ["case.stl", -1],
    ["case.stl", Number.NaN],
    ["case.stl", MODEL_MAX_BYTES + 1],
    ["code.html", 100],
  ] as const)
    expect(() => validateModelFile(name, size)).toThrow();
});
