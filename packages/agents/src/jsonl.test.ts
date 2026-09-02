import { describe, expect, test } from "bun:test";
import { parseJsonlLine, readJsonl, readTail } from "./jsonl";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const v of readJsonl(stream)) out.push(v);
  return out;
}

describe("readJsonl", () => {
  test("reassembles lines split across chunks and flushes a trailing line", async () => {
    const values = await collect(streamOf(['{"a":1}\n{"b":', '2}\n{"c":3}']));
    expect(values).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  test("skips blank, non-JSON and truncated lines and tolerates CRLF", async () => {
    const values = await collect(
      streamOf(['Warning: something\r\n\n{"ok":true}\r\n{"broken":\n[1,2]\n']),
    );
    expect(values).toEqual([{ ok: true }, [1, 2]]);
  });

  test("handles multi-byte characters across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode('{"t":"héllo — ok"}\n');
    const split = 9;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, split));
        controller.enqueue(bytes.slice(split));
        controller.close();
      },
    });
    expect(await collect(stream)).toEqual([{ t: "héllo — ok" }]);
  });
});

describe("parseJsonlLine", () => {
  test("returns undefined for scalars and garbage", () => {
    expect(parseJsonlLine("42")).toBeUndefined();
    expect(parseJsonlLine("")).toBeUndefined();
    expect(parseJsonlLine("{nope")).toBeUndefined();
    expect(parseJsonlLine('  {"x":1}  ')).toEqual({ x: 1 });
  });
});

describe("readTail", () => {
  test("keeps only the tail of a long stream", async () => {
    const text = await readTail(streamOf(["a".repeat(100), "b".repeat(100)]), 50);
    expect(text).toBe("b".repeat(50));
  });
});
