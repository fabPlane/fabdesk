import { expect, test } from "bun:test";
import { defaultEnclosureDesign } from "./enclosure-design";
import { EnclosureHistory, sameEnclosureDesign } from "./enclosure-history";

test("undo and redo restore complete enclosure edits, including removed boards and constraints", () => {
  const initial = defaultEnclosureDesign(null);
  initial.boards = [{ path: "board.kicad_pcb", x: 12, y: -3, z: 5, rotation: 90 }];
  const history = new EnclosureHistory();
  history.reset(initial);
  const enlarged = { ...initial, space: { ...initial.space, width: 150 } };
  history.commit(enlarged, "Resize interior");
  const removed = { ...enlarged, boards: [] };
  history.commit(removed, "Remove board");
  expect(history.undoLabel).toBe("Remove board");
  expect(history.undo()).toEqual(enlarged);
  expect(history.undo()).toEqual(initial);
  expect(history.undo()).toBeNull();
  expect(history.redoLabel).toBe("Resize interior");
  expect(history.redo()).toEqual(enlarged);
  expect(history.redo()).toEqual(removed);
  expect(history.redo()).toBeNull();
});

test("a new edit after undo drops only the abandoned future, and no-op edits do not consume history", () => {
  const initial = defaultEnclosureDesign(null),
    history = new EnclosureHistory();
  history.reset(initial);
  expect(history.commit(structuredClone(initial), "No change")).toBe(false);
  expect(history.undoLabel).toBeNull();
  history.commit({ ...initial, confirmed: true }, "Confirm dimensions");
  history.undo();
  expect(history.commit(initial, "No change")).toBe(false);
  expect(history.redoLabel).toBe("Confirm dimensions");
  history.commit({ ...initial, space: { ...initial.space, height: 40 } }, "Resize height");
  expect(history.redo()).toBeNull();
  expect(history.undo()).toEqual(initial);
});

test("history owns snapshots, bounds memory, and resets between projects", () => {
  const initial = defaultEnclosureDesign(null),
    history = new EnclosureHistory(2);
  history.reset(initial);
  initial.space.width = 1000;
  for (const width of [101, 102, 103]) {
    const next = defaultEnclosureDesign(null);
    next.space.width = width;
    history.commit(next, `Width ${width}`);
    next.space.width = 900;
  }
  const previous = history.undo()!;
  expect(previous.space.width).toBe(102);
  previous.space.width = 800;
  expect(history.redo()!.space.width).toBe(103);
  expect(history.undo()!.space.width).toBe(102);
  expect(history.undo()!.space.width).toBe(101);
  expect(history.undo()).toBeNull();
  history.reset(defaultEnclosureDesign(null));
  expect(history.redo()).toBeNull();
  expect(history.undoLabel).toBeNull();
});

test("returning to the saved design can clear dirty state without truncating redo", () => {
  const saved = defaultEnclosureDesign(null),
    history = new EnclosureHistory();
  history.reset(saved);
  history.commit({ ...saved, confirmed: true }, "Confirm");
  expect(sameEnclosureDesign(history.undo()!, saved)).toBe(true);
  expect(history.redoLabel).toBe("Confirm");
  expect(sameEnclosureDesign(history.redo()!, saved)).toBe(false);
});
