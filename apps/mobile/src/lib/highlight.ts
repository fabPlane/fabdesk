/**
 * A small line tokenizer for the file viewer.
 *
 * Shiki and highlight.js both cost more bundle than the rest of this app; what a phone needs is
 * enough colour to read `circuit.tsx`, a JSON report or a `.kicad_pcb` at a glance. Each line is
 * split into runs with a tone, and the screen renders a run as a `<Text>` span. Multi-line
 * comments and template strings carry state from one line to the next so a FlatList can render
 * any line on its own given the state its predecessor ended in.
 */
import type { Language } from "./file-tree";

export type Tone = "plain" | "keyword" | "string" | "number" | "comment" | "punct" | "tag" | "prop";

export interface Run {
  text: string;
  tone: Tone;
}

/** What carries across a line break: nothing, an open block comment, or an open template literal. */
export type LineState = "none" | "comment" | "template";

export interface HighlightedLine {
  runs: Run[];
  /** State the next line starts in. */
  end: LineState;
}

const TS_KEYWORDS = new Set(
  (
    "as async await break case catch class const continue debugger default delete do else enum " +
    "export extends false finally for from function if implements import in instanceof interface " +
    "let new null of package private protected public return satisfies static super switch this " +
    "throw true try type typeof undefined var void while with yield keyof readonly declare " +
    "namespace abstract override"
  ).split(" "),
);

const SEXPR_KEYWORDS = new Set(
  (
    "kicad_pcb kicad_sch kicad_symbol_lib module footprint symbol pad net layer layers segment via " +
    "gr_line gr_rect gr_arc gr_circle gr_poly fp_line fp_text fp_circle fp_arc property wire junction " +
    "label global_label hierarchical_label sheet lib_symbols zone polygon filled_polygon general " +
    "setup paper title_block at start end mid center size drill width stroke fill uuid tstamp effects font"
  ).split(" "),
);

export function highlightLine(
  line: string,
  language: Language,
  state: LineState = "none",
): HighlightedLine {
  switch (language) {
    case "ts":
      return tokenizeC(line, state, TS_KEYWORDS);
    case "json":
      return tokenizeJson(line);
    case "sexpr":
      return tokenizeSexpr(line);
    case "markdown":
      return tokenizeMarkdown(line);
    default:
      return { runs: line ? [{ text: line, tone: "plain" }] : [], end: "none" };
  }
}

/** Every line of a file, threading the state so block comments span lines. */
export function highlightText(text: string, language: Language): HighlightedLine[] {
  const out: HighlightedLine[] = [];
  let state: LineState = "none";
  for (const line of text.split("\n")) {
    const h = highlightLine(line, language, state);
    out.push(h);
    state = h.end;
  }
  return out;
}

function push(runs: Run[], text: string, tone: Tone) {
  if (!text) return;
  const last = runs[runs.length - 1];
  if (last && last.tone === tone) last.text += text;
  else runs.push({ text, tone });
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const NUMBER = /^(0x[0-9a-fA-F_]+|0b[01_]+|\d[\d_]*(\.\d+)?([eE][+-]?\d+)?)/;

/** JavaScript/TypeScript family: comments, strings, templates, numbers, keywords, JSX tags. */
function tokenizeC(line: string, state: LineState, keywords: ReadonlySet<string>): HighlightedLine {
  const runs: Run[] = [];
  let i = 0;
  let mode: LineState = state;
  while (i < line.length) {
    if (mode === "comment") {
      const close = line.indexOf("*/", i);
      if (close === -1) {
        push(runs, line.slice(i), "comment");
        return { runs, end: "comment" };
      }
      push(runs, line.slice(i, close + 2), "comment");
      i = close + 2;
      mode = "none";
      continue;
    }
    if (mode === "template") {
      const end = scanString(line, i, "`", true);
      push(runs, line.slice(i, end.index), "string");
      i = end.index;
      if (!end.closed) return { runs, end: "template" };
      mode = "none";
      continue;
    }
    const ch = line[i]!;
    const next = line[i + 1];
    if (ch === "/" && next === "/") {
      push(runs, line.slice(i), "comment");
      return { runs, end: "none" };
    }
    if (ch === "/" && next === "*") {
      mode = "comment";
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = scanString(line, i + 1, ch, false);
      push(runs, line.slice(i, end.index), "string");
      i = end.index;
      continue;
    }
    if (ch === "`") {
      mode = "template";
      push(runs, "`", "string");
      i += 1;
      continue;
    }
    const num = NUMBER.exec(line.slice(i));
    if (num && !/[A-Za-z0-9_$]/.test(line[i - 1] ?? "")) {
      push(runs, num[0], "number");
      i += num[0].length;
      continue;
    }
    const id = IDENT.exec(line.slice(i));
    if (id) {
      const word = id[0];
      const tone: Tone = keywords.has(word)
        ? "keyword"
        : line[i - 1] === "<" || (line[i - 1] === "/" && line[i - 2] === "<")
          ? "tag"
          : /^\s*[:=]/.test(line.slice(i + word.length)) && line[i - 1] !== "."
            ? "prop"
            : "plain";
      push(runs, word, tone);
      i += word.length;
      continue;
    }
    if (/[{}()[\]<>;,.=+\-*/%!&|?:]/.test(ch)) {
      push(runs, ch, "punct");
      i += 1;
      continue;
    }
    push(runs, ch, "plain");
    i += 1;
  }
  return { runs, end: mode === "comment" ? "comment" : "none" };
}

/** Index just past the closing quote, or the line end; `multiline` strings stay open at EOL. */
function scanString(
  line: string,
  from: number,
  quote: string,
  multiline: boolean,
): { index: number; closed: boolean } {
  let i = from;
  while (i < line.length) {
    const ch = line[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return { index: i + 1, closed: true };
    i += 1;
  }
  return { index: line.length, closed: !multiline };
}

function tokenizeJson(line: string): HighlightedLine {
  const runs: Run[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '"') {
      const end = scanString(line, i + 1, '"', false);
      const text = line.slice(i, end.index);
      const isKey = /^\s*:/.test(line.slice(end.index));
      push(runs, text, isKey ? "prop" : "string");
      i = end.index;
      continue;
    }
    const num = NUMBER.exec(line.slice(i));
    if (num || (ch === "-" && NUMBER.test(line.slice(i + 1)))) {
      const len = num ? num[0].length : 1 + NUMBER.exec(line.slice(i + 1))![0].length;
      push(runs, line.slice(i, i + len), "number");
      i += len;
      continue;
    }
    const word = /^(true|false|null)/.exec(line.slice(i));
    if (word) {
      push(runs, word[0], "keyword");
      i += word[0].length;
      continue;
    }
    push(runs, ch, /[{}[\]:,]/.test(ch) ? "punct" : "plain");
    i += 1;
  }
  return { runs, end: "none" };
}

/** KiCad's s-expressions: the head of each list is a keyword, quoted strings, numbers, parens. */
function tokenizeSexpr(line: string): HighlightedLine {
  const runs: Run[] = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '"') {
      const end = scanString(line, i + 1, '"', false);
      push(runs, line.slice(i, end.index), "string");
      i = end.index;
      continue;
    }
    if (ch === "(" || ch === ")") {
      push(runs, ch, "punct");
      i += 1;
      continue;
    }
    const num = /^-?\d+(\.\d+)?/.exec(line.slice(i));
    if (num && !/[A-Za-z0-9_.-]/.test(line[i - 1] ?? "")) {
      push(runs, num[0], "number");
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_.*-]*/.exec(line.slice(i));
    if (word) {
      const head = line[i - 1] === "(";
      push(runs, word[0], head ? (SEXPR_KEYWORDS.has(word[0]) ? "keyword" : "prop") : "plain");
      i += word[0].length;
      continue;
    }
    push(runs, ch, "plain");
    i += 1;
  }
  return { runs, end: "none" };
}

/** Markdown source (the raw view): headings, fences, list markers and inline code get a tone. */
function tokenizeMarkdown(line: string): HighlightedLine {
  if (/^\s*#{1,6}\s/.test(line)) return { runs: [{ text: line, tone: "keyword" }], end: "none" };
  if (/^\s*(```|~~~)/.test(line)) return { runs: [{ text: line, tone: "punct" }], end: "none" };
  const runs: Run[] = [];
  const marker = /^(\s*)([-*+]|\d+\.)(\s+)/.exec(line);
  let i = 0;
  if (marker) {
    push(runs, marker[1]!, "plain");
    push(runs, marker[2]!, "punct");
    push(runs, marker[3]!, "plain");
    i = marker[0].length;
  }
  while (i < line.length) {
    if (line[i] === "`") {
      const close = line.indexOf("`", i + 1);
      const end = close === -1 ? line.length : close + 1;
      push(runs, line.slice(i, end), "string");
      i = end;
      continue;
    }
    push(runs, line[i]!, "plain");
    i += 1;
  }
  return { runs, end: "none" };
}
