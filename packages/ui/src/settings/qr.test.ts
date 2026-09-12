import { describe, expect, test } from "bun:test";
import { qrSvg } from "./qr";

describe("qrSvg", () => {
  test("renders a square svg with a quiet zone and dark modules", () => {
    const svg = qrSvg("fabdesk://pair?v=1&t=abc&p=47820&n=lab&h=100.64.0.1");
    const box = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    expect(box).not.toBeNull();
    expect(box![1]).toBe(box![2]!);
    // Smallest QR is 21 modules; plus the 4-module quiet zone on each side.
    expect(Number(box![1])).toBeGreaterThanOrEqual(21 + 8);
    expect(svg).toContain('<path d="M');
  });

  test("a longer payload needs a bigger symbol", () => {
    const small = qrSvg("fabdesk://pair?v=1&t=a&p=1&n=x&h=1.1.1.1");
    const large = qrSvg(`fabdesk://pair?v=1&t=${"x".repeat(200)}&p=47820&n=a-long-machine-name&h=100.64.0.1&h=192.168.1.24`);
    const size = (svg: string) => Number(/viewBox="0 0 (\d+)/.exec(svg)![1]);
    expect(size(large)).toBeGreaterThan(size(small));
  });

  test("payload characters that look like markup cannot escape the path data", () => {
    const svg = qrSvg('fabdesk://pair?v=1&t=<script>&p=1&n=x&h=1.1.1.1');
    expect(svg).not.toContain("<script>");
  });
});
