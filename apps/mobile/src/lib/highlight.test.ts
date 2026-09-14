import { describe, expect, test } from "bun:test";
import { highlightLine, highlightText, type Run } from "./highlight";

const tones = (runs: Run[]) => runs.map((r) => `${r.tone}:${r.text}`);
const joined = (runs: Run[]) => runs.map((r) => r.text).join("");

describe("typescript", () => {
  test("keywords, strings, numbers, comments and props get tones; text is preserved", () => {
    const line = 'const width = 1.6; // mm "not a string"';
    const h = highlightLine(line, "ts");
    expect(joined(h.runs)).toBe(line);
    expect(tones(h.runs)).toEqual([
      "keyword:const",
      "plain: ",
      "prop:width",
      "plain: ",
      "punct:=",
      "plain: ",
      "number:1.6",
      "punct:;",
      "plain: ",
      'comment:// mm "not a string"',
    ]);
  });

  test("a block comment carries state across lines", () => {
    const lines = highlightText("/* a\n b */ const x\nlet y", "ts");
    expect(lines.map((l) => l.end)).toEqual(["comment", "none", "none"]);
    expect(lines[1]?.runs[0]).toEqual({ text: " b */", tone: "comment" });
    expect(lines[1]?.runs.some((r) => r.tone === "keyword" && r.text === "const")).toBe(true);
  });

  test("template literals stay strings across lines; JSX tags are tagged", () => {
    const lines = highlightText("const s = `a\nb` + <Board layers={2} />", "ts");
    expect(lines[0]?.end).toBe("template");
    expect(lines[1]?.runs[0]).toEqual({ text: "b`", tone: "string" });
    expect(tones(lines[1]?.runs ?? [])).toContain("tag:Board");
    expect(tones(lines[1]?.runs ?? [])).toContain("prop:layers");
  });

  test("escaped quotes do not end a string", () => {
    const h = highlightLine('"a\\"b" + 1', "ts");
    expect(h.runs[0]).toEqual({ text: '"a\\"b"', tone: "string" });
  });
});

describe("json", () => {
  test("keys, values, numbers and literals", () => {
    const h = highlightLine('{"layers": 2, "name": "blinky", "ok": true, "x": -1.5}', "json");
    expect(tones(h.runs).filter((t) => !t.startsWith("plain"))).toEqual([
      "punct:{",
      'prop:"layers"',
      "punct::",
      "number:2",
      "punct:,",
      'prop:"name"',
      "punct::",
      'string:"blinky"',
      "punct:,",
      'prop:"ok"',
      "punct::",
      "keyword:true",
      "punct:,",
      'prop:"x"',
      "punct::",
      "number:-1.5",
      "punct:}",
    ]);
  });
});

describe("s-expressions", () => {
  test("list heads are keywords or props, quoted strings and numbers are toned", () => {
    const h = highlightLine(
      '  (gr_line (start 85 110) (end 115 110) (layer "Edge.Cuts"))',
      "sexpr",
    );
    expect(joined(h.runs)).toBe('  (gr_line (start 85 110) (end 115 110) (layer "Edge.Cuts"))');
    expect(tones(h.runs)).toContain("keyword:gr_line");
    expect(tones(h.runs)).toContain("keyword:start");
    expect(tones(h.runs)).toContain("number:110");
    expect(tones(h.runs)).toContain('string:"Edge.Cuts"');
    expect(highlightLine("(unknown_head 1)", "sexpr").runs[1]).toEqual({
      text: "unknown_head",
      tone: "prop",
    });
  });
});

describe("markdown and plain", () => {
  test("headings, fences, list markers, inline code", () => {
    expect(highlightLine("## Title", "markdown").runs).toEqual([
      { text: "## Title", tone: "keyword" },
    ]);
    expect(highlightLine("```ts", "markdown").runs[0]?.tone).toBe("punct");
    const li = highlightLine("- use `bun run test`", "markdown");
    expect(tones(li.runs)).toEqual(["punct:-", "plain: use ", "string:`bun run test`"]);
  });

  test("plain returns one run and nothing for an empty line", () => {
    expect(highlightLine("hello", "plain").runs).toEqual([{ text: "hello", tone: "plain" }]);
    expect(highlightLine("", "plain").runs).toEqual([]);
  });
});
