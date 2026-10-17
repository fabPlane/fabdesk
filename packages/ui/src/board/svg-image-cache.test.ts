import { describe, expect, test } from "bun:test";
import { createSvgImageCache } from "./svg-image-cache";

function cache(limit: number) {
  const blobs: Blob[] = [], revoked: string[] = [];
  return { blobs, revoked, ...createSvgImageCache(limit, {
    create: (blob) => { blobs.push(blob); return `blob:${blobs.length}`; },
    revoke: (url) => { revoked.push(url); },
  }) };
}

describe("SVG image cache", () => {
  test("returning to unchanged content reuses its vector image URL", () => {
    const c = cache(100);
    const first = c.acquire("<svg/>");
    first.release();
    const second = c.acquire("<svg/>");
    expect(second.url).toBe(first.url);
    expect(c.blobs.length).toBe(1);
    expect(c.blobs[0]?.type).toBe("image/svg+xml");
    expect(c.revoked).toEqual([]);
    second.release();
  });

  test("changed content gets a fresh URL and evicts the oldest unused image", () => {
    const c = cache(12);
    const first = c.acquire("<svg/>"); first.release();
    const second = c.acquire("<svg />"); second.release();
    expect(second.url).not.toBe(first.url);
    expect(c.revoked).toEqual([first.url]);
  });

  test("does not revoke a displayed image, even when the budget is exceeded", () => {
    const c = cache(6);
    const first = c.acquire("<svg/>");
    const same = c.acquire("<svg/>");
    const second = c.acquire("<svg />");
    first.release(); first.release();
    expect(c.revoked).toEqual([]);
    same.release();
    expect(c.revoked).toEqual([first.url]);
    second.release();
    expect(c.revoked).toEqual([first.url, second.url]);
  });

  test("evicts least recently used images and counts UTF-8 bytes", () => {
    const c = cache(4);
    c.acquire("aa").release();
    const second = c.acquire("bb"); second.release();
    c.acquire("aa").release();
    c.acquire("é").release();
    expect(c.revoked).toEqual([second.url]);
    expect(c.blobs[2]?.size).toBe(2);
  });
});
