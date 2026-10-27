import { expect, test } from "bun:test";
import { createFpPcbDesign } from "./fp-pcb-design";

const setup = (ownLocked: boolean, groupLocked: boolean) => {
  let committed = false, preflight = false;
  const footprint = { id: "part", reference: "R1", position: { x: 0, y: 0 }, orientation: 0, isFlipped: false, locked: ownLocked, clone() { return this; } };
  const board = {
    getFootprints: async () => [footprint],
    getGroups: async () => [{ id: "inner", items: ["part"], locked: false }, { id: "outer", items: ["inner"], locked: groupLocked }],
    modified: async () => { preflight = true; throw Error("unlocked preflight reached"); },
    commit: async () => { committed = true; },
  };
  const design = createFpPcbDesign({ bridge: () => ({}) as never, sessions: { board: async () => board } as never });
  return { design, state: () => ({ committed, preflight }) };
};

test("positioning a member of a locked ancestor group fails before mutation, even with own unlock", async () => {
  for (const lock of [undefined, false]) {
    const { design, state } = setup(false, true);
    await expect(design.placeFootprints("/fixture", [{ reference: "R1", position: { x: 1, y: 0 }, ...(lock === undefined ? {} : { lock }) }])).rejects.toThrow("locked group");
    expect(state()).toEqual({ committed: false, preflight: false });
  }
});

test("locked parts need an explicit unlock for geometry changes; unlocked groups do not block", async () => {
  const locked = setup(true, false);
  await expect(locked.design.placeFootprints("/fixture", [{ reference: "R1", position: { x: 1, y: 0 } }])).rejects.toThrow("R1 is locked");
  expect(locked.state()).toEqual({ committed: false, preflight: false });
  for (const ownLocked of [false, true]) {
    const open = setup(ownLocked, false);
    await expect(open.design.placeFootprints("/fixture", [{ reference: "R1", position: { x: 1, y: 0 }, ...(ownLocked ? { lock: false } : {}) }])).rejects.toThrow("unlocked preflight reached");
    expect(open.state()).toEqual({ committed: false, preflight: true });
  }
});

test("component inspection exposes the effective ancestor lock used by contextual tools", async () => {
  for (const [own, group] of [[false, true], [true, false], [false, false]] as const) {
    const { design } = setup(own, group);
    expect((await design.query("/fixture", "components"))[0]?.locked).toBe(own || group);
  }
});
