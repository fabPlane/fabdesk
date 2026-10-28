import { expect, test } from "bun:test";
import { latestPreviewQueue } from "./art-preview-queue";

test("removing an image discards queued renders and ignores its late preview", () => {
  const sent: number[] = [], shown: string[] = [];
  const q = latestPreviewQueue<string, string>(
    (id) => sent.push(id),
    (value) => shown.push(value),
  );
  q.request("removed image");
  q.request("pending edit");
  q.cancel();
  q.complete(1, "removed preview");
  expect(sent).toEqual([1]);
  expect(shown).toEqual([]);
  q.request("replacement image");
  q.complete(4, "replacement preview");
  expect(shown).toEqual(["replacement preview"]);
});

test("a rapid drag keeps one render in flight and only the latest pending placement", () => {
  const sent: Array<[number, number]> = [],
    shown: string[] = [];
  const q = latestPreviewQueue<number, string>(
    (id, position) => sent.push([id, position]),
    (result) => shown.push(result),
  );
  for (let i = 1; i <= 1000; i++) q.request(i);
  expect(sent).toEqual([[1, 1]]);
  q.complete(1, "old frame");
  expect(shown).toEqual([]);
  expect(sent).toEqual([
    [1, 1],
    [1000, 1000],
  ]);
  q.complete(1000, "final frame");
  expect(shown).toEqual(["final frame"]);
});

test("late duplicate replies never replace the newest preview", () => {
  const shown: string[] = [];
  const q = latestPreviewQueue<number, string>(
    () => {},
    (value) => shown.push(value),
  );
  q.request(1);
  q.request(2);
  q.complete(1, "old");
  q.complete(2, "new");
  q.complete(1, "late old");
  expect(shown).toEqual(["new"]);
});

test("a fresh render starts immediately after idle, including recovery after an error", () => {
  const sent: number[] = [],
    shown: Array<{ error?: string; svg?: string }> = [];
  const q = latestPreviewQueue<number, { error?: string; svg?: string }>(
    (id) => sent.push(id),
    (result) => shown.push(result),
  );
  q.request(1);
  q.complete(1, { error: "decode failed" });
  q.request(2);
  q.complete(2, { svg: "recovered" });
  expect(sent).toEqual([1, 2]);
  expect(shown).toEqual([{ error: "decode failed" }, { svg: "recovered" }]);
});
