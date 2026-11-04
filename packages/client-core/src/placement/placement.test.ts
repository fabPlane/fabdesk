import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  readPlacement,
  clone,
  analyzePlacement,
  moveParts,
  rotateParts,
  groupParts,
  expanded,
  shove,
  setAnchor,
  resizeBoard,
  suggestPlacement,
  reviewPlacement,
  exportBoard,
  placementHistory,
  commitPlacement,
  undoPlacement,
  redoPlacement,
  placementBoardFiles,
  placementDrafts,
  replaceFootprint,
  addPlacementFootprint,
  setPartValue,
  setAnchorOffset,
  swapPlacement,
  connectedNeighbors,
  nearestClearance,
  placementScore,
  saveAutosave,
  decodeAutosave,
} from "./index";

const source = readFileSync(new URL("./fixtures/usb-timer.kicad_pcb", import.meta.url), "utf8");
const fresh = () => readPlacement(source, "usb-timer.kicad_pcb");

test("resized board exports remain identical after reopening, but detect real layout changes", () => {
  const session = fresh();
  resizeBoard(session, 40, 30, true);
  const before = clone(session);
  const text = exportBoard(session);
  expect(exportBoard(session)).toBe(text);
  expect(exportBoard(readPlacement(JSON.stringify(session), "saved.placement.json"))).toBe(text);
  expect(session).toEqual(before);
  const ids = [...text.matchAll(/\(uuid\s+"?([\da-f-]+)"?\)/g)].map((match) => match[1]);
  expect(ids.length).toBeGreaterThan(4);
  expect(new Set(ids).size).toBe(ids.length);
  moveParts(session, [session.parts.find((part) => part.ref === "R5")!.id], 1, 0);
  expect(exportBoard(session)).not.toBe(text);
});

test("footprint replacement keeps identity and pad nets, and rejects incompatible pins", () => {
  const s = fresh(),
    p = s.parts.find((p) => p.ref === "R5")!;
  const original = clone(p);
  const replacement =
    '(footprint "Small resistor" (layer "F.Cu") (fp_rect (start -1 -0.5) (end 1 0.5) (layer "F.CrtYd")) (pad "1" smd rect (at -0.5 0) (size 0.5 0.5)) (pad "2" smd rect (at 0.5 0) (size 0.5 0.5)))';
  replaceFootprint(p, replacement, "Small resistor");
  expect([p.id, p.ref, p.value, p.x, p.y, p.angle]).toEqual([
    original.id,
    original.ref,
    original.value,
    original.x,
    original.y,
    original.angle,
  ]);
  expect(p.pads.map((p) => [p.number, p.net])).toEqual(original.pads.map((p) => [p.number, p.net]));
  const valid = clone(p);
  expect(() =>
    replaceFootprint(p, replacement.replace('pad "2"', 'pad "3"'), "Wrong pins"),
  ).toThrow(/Pad numbers/);
  expect(p).toEqual(valid);
});

test("KiCad board imports actual footprint positions and exports the native format", () => {
  const session = fresh();
  expect(session.parts).toHaveLength(12);
  expect(session.parts.find((p) => p.ref === "R5")).toMatchObject({ x: 7, y: 10.5, angle: 90 });
  const before = clone(session);
  const p = session.parts.find((p) => p.ref === "R5")!;
  moveParts(session, [p.id], 2, 3);
  rotateParts(session, [p.id]);
  const exported = exportBoard(session),
    imported = readPlacement(exported, "copy.kicad_pcb");
  expect(imported.parts.find((q) => q.ref === "R5")).toMatchObject({ x: 9, y: 13.5, angle: 180 });
  expect(imported.parts.find((q) => q.ref === "R5")!.pads.map((q) => [q.number, q.net])).toEqual(
    p.pads.map((q) => [q.number, q.net]),
  );
  expect(session.root).toEqual(before.root);
  expect(exported).not.toMatch(/\((segment|via|zone)\s/);
});

test("undo restores a complete grouped edit and clears redo after another change", () => {
  const s = fresh(),
    ids = s.parts.slice(0, 2).map((p) => p.id);
  groupParts(s, ids);
  const history = placementHistory(s),
    next = clone(s);
  moveParts(next, [ids[0]!], 3, 2);
  shove(next, ids);
  const edited = commitPlacement(history, next);
  expect(undoPlacement(edited).present).toEqual(s);
  expect(redoPlacement(undoPlacement(edited)).present).toEqual(next);
  expect(commitPlacement(undoPlacement(edited), clone(s)).future).toHaveLength(0);
  expect(expanded(s, [ids[0]!])).toEqual(ids);
});

test("locked groups and anchors retain constrained coordinates", () => {
  const s = fresh(),
    ids = s.parts.slice(0, 2).map((p) => p.id);
  groupParts(s, ids);
  s.parts[0]!.locked = true;
  const before = clone(s.parts.slice(0, 2));
  moveParts(s, ids, 10, 10);
  expect(s.parts.slice(0, 2)).toEqual(before);
  expect(() => rotateParts(s, ids)).toThrow();
  const p = s.parts[2]!,
    oldX = p.x,
    oldY = p.y;
  setAnchor(s, p, "left");
  moveParts(s, [p.id], 5, 2);
  expect(p.x).toBe(oldX);
  expect(p.y).toBe(oldY + 2);
});

test("preview search leaves the original unchanged and does not introduce new findings", () => {
  const s = fresh(),
    before = clone(s);
  const result = suggestPlacement(s, [], { budgetMs: 120, maxSweeps: 1 });
  expect(s).toEqual(before);
  expect(reviewPlacement(s, result.candidate).added).toHaveLength(0);
  expect(result.after).toBeLessThanOrEqual(result.before + 0.001);
});

test("spacing guidelines are advisory and survive session migration", () => {
  const s = fresh(),
    findings = analyzePlacement(s).findings;
  s.spacingGuidelines = { enabled: true, courtyard: 3, edge: 2 };
  expect(analyzePlacement(s).findings).toEqual(findings);
  expect(analyzePlacement(s).guidelines.length).toBeGreaterThan(0);
  const legacy = { ...s, schema: "placement-lab/v4", clearance: 2, edgeClearance: 1 };
  const migrated = readPlacement(JSON.stringify(legacy), "old.placement.json");
  expect(migrated.spacingGuidelines).toEqual({ enabled: false, courtyard: 2, edge: 1 });
});

test("session round trips retain groups, anchors, locks, reserved areas and net weights", () => {
  const s = fresh();
  groupParts(
    s,
    s.parts.slice(0, 2).map((p) => p.id),
  );
  s.parts[2]!.locked = true;
  setAnchor(s, s.parts[3]!, "right");
  s.reservedAreas = [
    { id: "area", name: "Mount", x: 2, y: 2, w: 3, h: 4, margin: 0.2, side: "both" },
  ];
  s.netWeights = { GND: 2 };
  const restored = readPlacement(JSON.stringify(s), "draft.placement.json");
  expect(restored).toEqual(s);
});

test("resize preview preserves footprint dimensions and rejects invalid dimensions", () => {
  const s = fresh(),
    sizes = s.parts.map((p) => p.bounds);
  resizeBoard(s, s.board.w + 5, s.board.h + 5);
  expect(s.parts.map((p) => p.bounds)).toEqual(sizes);
  expect(() => resizeBoard(s, NaN, 20)).toThrow();
});

test("malformed session metadata and duplicate identities are rejected before rendering", () => {
  const s = fresh();
  s.parts[1]!.id = s.parts[0]!.id;
  expect(() => readPlacement(JSON.stringify(s), "bad.json")).toThrow(/Duplicate/i);
  expect(() => readPlacement(JSON.stringify({ ...fresh(), name: {} }), "bad.json")).toThrow(/name/);
  expect(() => readPlacement("not a board", "bad.kicad_pcb")).toThrow();
});

test("project board discovery excludes exported copies and prefers the working board", () => {
  expect(
    placementBoardFiles([
      { path: "placement/copy.kicad_pcb" },
      { path: "routed.kicad_pcb" },
      { path: "board.kicad_pcb" },
      { path: "renders/pcb.svg" },
    ]),
  ).toEqual(["board.kicad_pcb", "routed.kicad_pcb"]);
});

test("draft recovery is scoped to a project and retains unsaved history", () => {
  const h = placementHistory(fresh());
  placementDrafts.set("placement-test-a", h, -1);
  expect(placementDrafts.get("placement-test-a")).toEqual({ history: h, savedRevision: -1 });
  expect(placementDrafts.get("placement-test-b")).toBeUndefined();
});

test("library addition renews identities, keeps unique references and exports without nets", async () => {
  const { placementLibrary } = await import("./library");
  expect(placementLibrary).toHaveLength(42);
  const s = fresh(),
    entry = placementLibrary[0]!;
  const a = addPlacementFootprint(s, entry.text, entry.name, [3, 4]),
    b = addPlacementFootprint(s, entry.text, entry.name, [5, 6]);
  expect(a.ref).not.toBe(b.ref);
  expect(a.id).not.toBe(b.id);
  expect(a.pads.every((p) => !p.net)).toBe(true);
  setPartValue(a, "22k");
  const result = readPlacement(exportBoard(s), "added.kicad_pcb");
  expect(result.parts.find((p) => p.ref === a.ref)).toMatchObject({ x: 3, y: 4, value: "22k" });
  expect(result.parts.length).toBe(14);
});
test("resize supports fixed placement and preserves physical cutout sizes", async () => {
  const { default: examples } = await import("./examples.json");
  const s = readPlacement(
    examples.find((x) => x.name === "constraint-board")!.text,
    "constraint-board.kicad_pcb",
  );
  const poses = s.parts.map((p) => [p.x, p.y, p.angle]);
  resizeBoard(s, 80, 60, false);
  expect(s.parts.map((p) => [p.x, p.y, p.angle])).toEqual(poses);
  expect(readPlacement(exportBoard(s), "resized.kicad_pcb").board).toMatchObject({ w: 80, h: 60 });
});
test("swaps retain component identities/nets; anchors constrain offset edits", () => {
  const s = fresh(),
    a = s.parts.find((p) => p.ref === "R5")!,
    b = s.parts.find((p) => p.ref === "R1")!,
    old = clone(a);
  swapPlacement(s, a.id, b.id);
  expect([b.x, b.y, b.angle]).toEqual([old.x, old.y, old.angle]);
  expect(a.pads).toEqual(old.pads);
  setAnchor(s, a, "left");
  const x = a.x;
  setAnchorOffset(s, a.id, a.anchor!.offset + 2);
  expect(a.x).toBe(x + 2);
  expect(() => swapPlacement(s, a.id, b.id)).toThrow();
});
test("context and weights match the original board's geometry and connections", () => {
  const s = fresh(),
    p = s.parts.find((p) => p.ref === "R5")!;
  expect(nearestClearance(s, [p.id])?.ref).toBe("D1");
  expect(connectedNeighbors(s, [p.id])).toHaveLength(6);
  const before = placementScore(s);
  s.netWeights = Object.fromEntries(
    s.parts.flatMap((p) => p.pads.map((p) => [p.net, 0])).filter(([n]) => n),
  );
  expect(placementScore(s)).toBe(0);
  expect(before).toBeGreaterThan(0);
});
test("browser recovery falls back to compressed sessions without changing metadata", async () => {
  const text = JSON.stringify(fresh());
  let saved = "";
  const storage = {
    setItem: (_key: string, value: string) => {
      if (!value.includes("storageFormat")) throw Error("quota");
      saved = value;
    },
  };
  await saveAutosave(storage, "test-project", text);
  expect(await decodeAutosave(saved)).toBe(text);
});

test("anchor offsets preserve rigid groups and reject a second anchor on the constrained axis", () => {
  const s = fresh(),
    a = s.parts.find((p) => p.ref === "R5")!,
    b = s.parts.find((p) => p.ref === "R1")!;
  groupParts(s, [a.id, b.id]);
  setAnchor(s, a, "left");
  const before = [a.x, b.x];
  setAnchorOffset(s, a.id, a.anchor!.offset + 1.25);
  expect([a.x, b.x]).toEqual(before.map((x) => x + 1.25));
  setAnchor(s, b, "right");
  const unchanged = JSON.stringify(s);
  expect(() => setAnchorOffset(s, a.id, a.anchor!.offset + 1)).toThrow("Another edge anchor");
  expect(JSON.stringify(s)).toBe(unchanged);
});
