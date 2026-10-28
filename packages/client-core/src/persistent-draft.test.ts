import { expect, test } from "bun:test";
import { PersistentDraft } from "./persistent-draft";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test("late restore never overwrites a newer staged draft", async () => {
  const read = deferred<string | null>();
  const draft = new PersistentDraft({
    read: () => read.promise,
    write: async (_value: string) => {},
  });
  const loading = draft.load();
  draft.stage("new artwork");
  read.resolve("old artwork");
  expect(await loading).toBe("new artwork");
});

test("project switches keep writes scoped to their owner and serialize revisions", async () => {
  const first = deferred<void>();
  const writes: string[] = [];
  const a = new PersistentDraft({
    read: async () => null,
    write: async (v: string) => {
      writes.push(`a:${v}`);
      if (v === "first") await first.promise;
    },
  });
  const b = new PersistentDraft({
    read: async () => null,
    write: async (v: string) => {
      writes.push(`b:${v}`);
    },
  });
  a.stage("first");
  const saving = a.save();
  await new Promise((r) => setTimeout(r, 0));
  a.stage("stale");
  const stale = a.save();
  a.stage("latest");
  const latest = a.save();
  b.stage("other project");
  await b.save();
  first.resolve();
  await Promise.all([saving, stale, latest]);
  expect(writes).toEqual(["a:first", "b:other project", "a:latest"]);
  expect(await a.load()).toBe("latest");
  expect(await b.load()).toBe("other project");
});

test("failed saves can retry without losing the current image/settings", async () => {
  let fail = true;
  let saved = "";
  const draft = new PersistentDraft({
    read: async () => null,
    write: async (value: string) => {
      if (fail) throw new Error("offline");
      saved = value;
    },
  });
  draft.stage("image with placement and colors");
  await expect(draft.save()).rejects.toThrow("offline");
  fail = false;
  await draft.save();
  expect(saved).toBe("image with placement and colors");
});
