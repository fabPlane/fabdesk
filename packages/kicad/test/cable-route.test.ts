import { expect, test } from "bun:test";
import { routeCable } from "../../protocol/src/cable-route";
import { cableAssessments } from "@fabdesk/protocol";
import { defaultEnclosureDesign } from "../../client-core/src/enclosure-design";
const room = { name: "room", x: 0, y: 0, z: 0, width: 100, depth: 80, height: 30 };
const a = { x: 10, y: 40, z: 15 },
  b = { x: 90, y: 40, z: 15 };
test("routes around a full-height obstruction with space for every bend", () => {
  const obstacle = { name: "board", x: 40, y: 25, z: 0, width: 20, depth: 30, height: 30 };
  const v = routeCable(a, b, room, [obstacle], 2, 4, 1);
  expect(v.route).not.toBeNull();
  expect(v.route!.length).toBeGreaterThan(80);
  expect(v.route!.bends).toBe(2);
  expect(v.route!.points.some((p) => p.y < 23 || p.y > 57)).toBe(true);
  expect(routeCable(a, b, room, [obstacle], 2, 4, 1)).toEqual(v);
});
test("solid partition and inadequate bend clearance do not return a false clear route", () => {
  expect(
    routeCable(
      a,
      b,
      room,
      [{ name: "partition", x: 40, y: 0, z: 0, width: 20, depth: 80, height: 30 }],
      2,
      4,
      1,
    ).route,
  ).toBeNull();
  const wall = { name: "wall", x: 40, y: 8, z: 0, width: 20, depth: 64, height: 30 };
  expect(routeCable(a, b, room, [wall], 2, 8, 1).route).toBeNull();
  expect(routeCable(a, b, room, [], 2, 4, 1).route!.length).toBe(80);
});
test("3D route respects floor, lid and endpoint clearance", () => {
  const raised = { ...b, z: 22 };
  const v = routeCable(a, raised, room, [], 2, 3, 1);
  expect(v.route!.length).toBe(87);
  expect(v.route!.points.every((p) => p.z >= 2 && p.z <= 28)).toBe(true);
  expect(routeCable({ ...a, z: 0 }, b, room, [], 2, 3, 1).route).toBeNull();
});
test("routed length cannot use the straight-line shortcut and unknown endpoints remain unknown", () => {
  const d = defaultEnclosureDesign(null);
  d.space = { ...d.space, x: 0, y: 0, width: 100, depth: 80, height: 30, floor: 0.5, clearance: 1 };
  d.obstacles = [{ name: "partition", x: 40, y: 25, z: 0, width: 20, depth: 30, height: 40 }];
  const boards = [a, b].map((p, i) => ({
    placement: { path: `${i}.kicad_pcb`, x: p.x, y: p.y, z: 13, rotation: 0 },
    features: {
      thicknessMm: 1,
      connectors: [{ ref: "J", x: 0, y: 0, heightMm: 2, edge: "minX" as const }],
    },
  }));
  d.boards = boards.map((b) => b.placement);
  d.connections = [
    {
      id: "test",
      from: { boardPath: "0.kicad_pcb", ref: "J" },
      to: { boardPath: "1.kicad_pcb", ref: "J" },
      length: 85,
      slack: 1,
      routing: { diameter: 2, bendRadius: 4 },
    },
  ];
  expect(cableAssessments(d, boards)[0]!.reachable).toBe(true);
  const routed = cableAssessments(d, boards, true)[0]!;
  expect(routed.route!.route).not.toBeNull();
  expect(routed.reachable).toBe(false);
  expect(routed.required!).toBeGreaterThan(85);
  d.connections[0]!.to.ref = "missing";
  expect(cableAssessments(d, boards, true)[0]!.distance).toBeNull();
});
test("later cable corridors reserve earlier cables rather than passing through them", () => {
  const d = defaultEnclosureDesign(null);
  d.space = { ...d.space, x: 0, y: 0, width: 100, depth: 80, height: 30, floor: 0.5, clearance: 1 };
  const points = [
    { x: 10, y: 40 },
    { x: 90, y: 40 },
    { x: 50, y: 10 },
    { x: 50, y: 70 },
  ];
  const boards = points.map((p, i) => ({
    placement: { path: `${i}.kicad_pcb`, ...p, z: 13, rotation: 0 },
    features: {
      thicknessMm: 1,
      connectors: [{ ref: "J", x: 0, y: 0, heightMm: 2, edge: "minX" as const }],
    },
  }));
  d.boards = boards.map((b) => b.placement);
  d.connections = [0, 2].map((i) => ({
    id: `${i}`,
    from: { boardPath: `${i}.kicad_pcb`, ref: "J" },
    to: { boardPath: `${i + 1}.kicad_pcb`, ref: "J" },
    length: 150,
    slack: 0,
    routing: { diameter: 2, bendRadius: 3 },
  }));
  const result = cableAssessments(d, boards, true);
  expect(result.every((c) => c.reachable)).toBe(true);
  expect(result[1]!.route!.route!.length).toBeGreaterThan(60);
  expect(result[1]!.route!.route!.points.some((p) => p.z !== 15)).toBe(true);
});
