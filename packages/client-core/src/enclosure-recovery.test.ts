import { expect, test } from "bun:test";
import { defaultEnclosureDesign } from "./enclosure-design";
import {
  enclosureRecoveryKey,
  EnclosureRecoveryStore,
  enclosureRecoveryAction,
} from "./enclosure-recovery";

test("automatic recovery only restores drafts based on the unchanged saved design", () => {
  const saved = defaultEnclosureDesign(null),
    draft = { ...saved, space: { ...saved.space, width: 150 } };
  const recovered = {
    version: 1 as const,
    design: draft,
    baseRevision: "a".repeat(64),
    savedAt: 1,
  };
  expect(enclosureRecoveryAction(recovered, saved, recovered.baseRevision)).toBe("restore");
  expect(enclosureRecoveryAction(recovered, saved, "b".repeat(64))).toBe("conflict");
  expect(enclosureRecoveryAction(null, saved, null)).toBe("none");
  const reordered = Object.fromEntries(Object.entries(saved).reverse()) as typeof saved;
  expect(
    enclosureRecoveryAction({ ...recovered, design: reordered }, saved, recovered.baseRevision),
  ).toBe("discard");
});

function storage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  };
}
test("local recovery survives daemon port changes and isolates projects and remote servers", () => {
  const a = enclosureRecoveryKey("http://127.0.0.1:1234", "p1", "C:/design");
  expect(enclosureRecoveryKey("http://localhost:5678", "p1", "C:/design")).toBe(a);
  expect(enclosureRecoveryKey("http://localhost:5678", "p2", "C:/design")).not.toBe(a);
  expect(enclosureRecoveryKey("http://localhost:5678", "p1", "C:/other")).not.toBe(a);
  expect(enclosureRecoveryKey("https://host:4000", "p1", "/design")).not.toBe(
    enclosureRecoveryKey("https://host:4001", "p1", "/design"),
  );
  expect(
    enclosureRecoveryKey("https://name:secret@host/path?token=secret", "p1", "/design"),
  ).not.toContain("secret");
});
test("a complete design and its saved revision survive reopening without modifying source objects", () => {
  const io = storage(),
    first = new EnclosureRecoveryStore(io, "project");
  const design = defaultEnclosureDesign(null);
  expect(first.store(design, "a".repeat(64), 123)).toBe(true);
  design.space.width = 1;
  const restored = new EnclosureRecoveryStore(io, "project").load()!;
  expect(restored.design.space.width).toBe(100);
  expect(restored.baseRevision).toBe("a".repeat(64));
  expect(restored.savedAt).toBe(123);
});
test("invalid edits keep the last complete recovery copy, and successful save clears only its own copy", () => {
  const io = storage(),
    a = new EnclosureRecoveryStore(io, "project"),
    b = new EnclosureRecoveryStore(io, "project");
  const design = defaultEnclosureDesign(null);
  a.store(design, null, 1);
  expect(a.store({ ...design, space: { ...design.space, width: -1 } }, null, 2)).toBe(false);
  expect(a.load()!.savedAt).toBe(1);
  b.store({ ...design, confirmed: true }, null, 3);
  a.clear();
  expect(b.load()!.design.confirmed).toBe(true);
  b.clear();
  expect(b.load()).toBeNull();
});
test("malformed, oversized and invalid-path recovery data cannot be restored", () => {
  const io = storage(),
    store = new EnclosureRecoveryStore(io, "project");
  for (const raw of ["not json", "x".repeat(1_000_001), JSON.stringify({ version: 2 })]) {
    io.setItem("project", raw);
    expect(() => store.load()).toThrow();
  }
  const design = defaultEnclosureDesign(null);
  design.boards = [{ path: "../other.kicad_pcb", x: 0, y: 0, z: 5, rotation: 0 }];
  io.setItem("project", JSON.stringify({ version: 1, design, savedAt: 1, baseRevision: null }));
  expect(() => store.load()).toThrow();
});
test("storage failure is surfaced without marking an unwritten copy as owned", () => {
  const io = storage();
  io.setItem("project", "other window");
  const store = new EnclosureRecoveryStore(
    {
      ...io,
      setItem: () => {
        throw new Error("quota");
      },
    },
    "project",
  );
  expect(() => store.store(defaultEnclosureDesign(null), null)).toThrow("quota");
  store.clear();
  expect(io.getItem("project")).toBe("other window");
});
