import { describe, expect, test } from "bun:test";
import { QUIET, qrMatrix, qrSvg, qrTerminal } from "./index";

const URL = "fabdesk://pair?v=1&t=abc&p=47820&n=lab&h=100.64.0.1";

describe("qrMatrix", () => {
  test("is square, at least version 1, with a finder pattern in each corner", () => {
    const { size, modules } = qrMatrix(URL);
    expect(size).toBeGreaterThanOrEqual(21);
    expect(size % 4).toBe(1); // 21, 25, 29 … — every QR version is 17 + 4n modules wide.
    expect(modules).toHaveLength(size);
    for (const line of modules) expect(line).toHaveLength(size);
    // A finder pattern is a 7×7 dark ring around a 3×3 dark core with a light ring between;
    // the top-left one starts at (0,0), the other two sit in the other top and bottom-left corners.
    const finder = (r0: number, c0: number) => {
      for (let i = 0; i < 7; i++) {
        expect(modules[r0]![c0 + i]).toBe(true);
        expect(modules[r0 + 6]![c0 + i]).toBe(true);
        expect(modules[r0 + i]![c0]).toBe(true);
        expect(modules[r0 + i]![c0 + 6]).toBe(true);
      }
      expect(modules[r0 + 1]![c0 + 1]).toBe(false);
      expect(modules[r0 + 3]![c0 + 3]).toBe(true);
    };
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);
  });

  test("a longer payload needs a bigger symbol", () => {
    const small = qrMatrix("fabdesk://pair?v=1&t=a&p=1&n=x&h=1.1.1.1").size;
    const large = qrMatrix(
      `fabdesk://pair?v=1&t=${"x".repeat(200)}&p=47820&n=a-long-machine-name&h=100.64.0.1&h=192.168.1.24`,
    ).size;
    expect(large).toBeGreaterThan(small);
  });
});

describe("qrSvg", () => {
  test("renders a square svg with a quiet zone and dark modules", () => {
    const svg = qrSvg(URL);
    const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    expect(box).not.toBeNull();
    expect(box![1]).toBe(box![2]!);
    expect(Number(box![1])).toBe(qrMatrix(URL).size + QUIET * 2);
    expect(svg).toContain('<path d="M');
    // The first dark module is the top-left finder corner, offset by the quiet zone.
    expect(svg).toContain(`M${QUIET} ${QUIET}h1v1h-1z`);
  });

  test("payload characters that look like markup cannot escape the path data", () => {
    expect(qrSvg("fabdesk://pair?v=1&t=<script>&p=1&n=x&h=1.1.1.1")).not.toContain("<script>");
  });
});

describe("qrTerminal", () => {
  test("packs two module rows per line, quiet zone included, using only the four block glyphs", () => {
    const { size } = qrMatrix(URL);
    const out = qrTerminal(URL);
    const lines = out.split("\n");
    expect(lines).toHaveLength(Math.ceil((size + 4) / 2));
    for (const line of lines) {
      expect([...line]).toHaveLength(size + 4);
      expect(line).toMatch(/^[█▀▄ ]+$/);
    }
    // Quiet zone: the first line and the first two columns are all light, i.e. full blocks.
    expect(lines[0]).toBe("█".repeat(size + 4));
    // (An odd box height ends on a half line, whose quiet zone is the upper half only.)
    for (const line of lines) expect(line.slice(0, 2)).toMatch(/^(██|▀▀)$/);
    // Line 1 holds module rows 0 and 1 of the top-left finder pattern, at column 2: the top row is
    // seven dark modules (nothing drawn), the row under it is dark, five light, dark — so the
    // middle five cells show their lower half only.
    expect([...lines[1]!].slice(2, 9).join("")).toBe(" ▄▄▄▄▄ ");
  });

  test("invert swaps the polarity for light terminals", () => {
    const normal = qrTerminal(URL, { quiet: 1 }).split("\n");
    const swapped = qrTerminal(URL, { quiet: 1, invert: true }).split("\n");
    expect(swapped).toHaveLength(normal.length);
    const flip: Record<string, string> = { "█": " ", " ": "█", "▀": "▄", "▄": "▀" };
    // Every full line flips exactly; the trailing half line only in its top half.
    for (let i = 0; i < normal.length - 1; i++) {
      expect(swapped[i]).toBe([...normal[i]!].map((ch) => flip[ch]!).join(""));
    }
  });
});
