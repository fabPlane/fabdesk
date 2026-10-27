import { expect, test } from "bun:test";
import { sketchRecoverySignature, createSketchRecoveryStore, parseSketchRecovery, sketchRecoveryKey, type SketchRecovery } from "./sketch-recovery";
const record = (label: string): SketchRecovery => ({ version: 1, scene: JSON.stringify({ type: "excalidraw", version: 2, elements: [{ id: label }] }), updatedAt: 1 });
test("draft keys isolate connections, projects, conversations and projectless drafts", () => {
  expect(new Set([["a", null, null], ["b", null, null], ["a", "null", null], ["a", "p", null], ["a", "p", "t"], ["a", "p", "other"]].map(args => sketchRecoveryKey(...args as [string, string | null, string | null]))).size).toBe(6);
});
test("recovery preserves imported bytes but rejects corrupt, oversized and unsupported records", async () => {
  const source = { blob: new Blob(["original bytes"]), name: "source.excalidraw", lastModified: 42 };
  expect(await parseSketchRecovery({ ...record("shape"), source })?.source?.blob.text()).toBe("original bytes");
  for (const value of [null, {}, { ...record("shape"), version: 2 }, { ...record("shape"), scene: "bad" }, { ...record("shape"), source: { ...source, blob: {} } }, { ...record("shape"), source: { ...source, name: "source.js" } }, { ...record("shape"), scene: " ".repeat(10 * 1024 * 1024 + 1) }]) expect(parseSketchRecovery(value)).toBeNull();
});
test("pending writes finish in order and cleanup wins before a new mount reads", async () => {
  const data = new Map<string, unknown>(); let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const store = createSketchRecoveryStore({ read: async key => data.get(key), write: async (key, value) => { if (value.scene.includes("first")) await blocked; data.set(key, value); }, remove: async key => { data.delete(key); } });
  const first = store.write("owned", record("first")), last = store.write("owned", record("last"));
  const other = await store.write("other", record("separate")); expect(other).toBeUndefined();
  const cleanup = store.remove("owned"), reopened = store.read("owned"); finish();
  await Promise.all([first, last, cleanup]); expect(await reopened).toBeNull();
  expect((await store.read("other"))?.scene).toContain("separate");
});
test("storage failures are visible and do not poison retry or delete a recoverable record", async () => {
  let saved: unknown = record("retained"), fail = true;
  const store = createSketchRecoveryStore({ read: async () => saved, write: async (_key, value) => { if (fail) throw new Error("quota"); saved = value; }, remove: async () => { saved = null; } });
  await expect(store.write("owned", record("new"))).rejects.toThrow("quota");
  expect((await store.read("owned"))?.scene).toContain("retained"); fail = false;
  await store.write("owned", record("new")); expect((await store.read("owned"))?.scene).toContain("new");
});

test("the first content edit and deletion differ from an empty/recovered draft, while identical content stays stable", () => {
  const element = { id: "first", version: 1, versionNonce: 3, isDeleted: false };
  expect(sketchRecoverySignature([element])).not.toBe(sketchRecoverySignature([]));
  expect(sketchRecoverySignature([{ ...element }])).toBe(sketchRecoverySignature([element]));
  expect(sketchRecoverySignature([{ ...element, version: 2 }])).not.toBe(sketchRecoverySignature([element]));
  expect(sketchRecoverySignature([{ ...element, isDeleted: true }])).not.toBe(sketchRecoverySignature([element]));
});
