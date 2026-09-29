import { describe, expect, test } from "bun:test";
import {
  COMPOSER_TEXTAREA_MAX_PX,
  COMPOSER_TEXTAREA_MIN_PX,
  applyComposerTextareaHeight,
  composerTextareaHeight,
} from "./composer-autosize";

describe("composerTextareaHeight", () => {
  test("empty draft stays compact even when scrollHeight is the old 240px first-paint bug", () => {
    expect(
      composerTextareaHeight({ scrollHeight: COMPOSER_TEXTAREA_MAX_PX, clientWidth: 720, value: "" }),
    ).toBe(COMPOSER_TEXTAREA_MIN_PX);
    expect(composerTextareaHeight({ scrollHeight: 400, clientWidth: 720, value: "" })).toBe(COMPOSER_TEXTAREA_MIN_PX);
  });

  test("unsettled width stays compact so a wrapped placeholder cannot inflate the first paint", () => {
    expect(composerTextareaHeight({ scrollHeight: 400, clientWidth: 0, value: "hello" })).toBe(COMPOSER_TEXTAREA_MIN_PX);
    expect(composerTextareaHeight({ scrollHeight: 12, clientWidth: 0, value: "" })).toBe(COMPOSER_TEXTAREA_MIN_PX);
  });

  test("clamps non-empty content between min and max", () => {
    expect(composerTextareaHeight({ scrollHeight: 20, clientWidth: 720, value: "x" })).toBe(COMPOSER_TEXTAREA_MIN_PX);
    expect(composerTextareaHeight({ scrollHeight: 80, clientWidth: 720, value: "line\nline\nline" })).toBe(80);
    expect(composerTextareaHeight({ scrollHeight: 400, clientWidth: 720, value: "long" })).toBe(COMPOSER_TEXTAREA_MAX_PX);
  });
});

describe("applyComposerTextareaHeight", () => {
  test("writes the compact min without using scrollHeight on an empty field", () => {
    const el = { style: { height: "" }, scrollHeight: 240, clientWidth: 640 };
    expect(applyComposerTextareaHeight(el, "")).toBe(COMPOSER_TEXTAREA_MIN_PX);
    expect(el.style.height).toBe(`${COMPOSER_TEXTAREA_MIN_PX}px`);
  });

  test("sizes to content and caps at max once width and value are real", () => {
    const el = { style: { height: "240px" }, scrollHeight: 96, clientWidth: 640 };
    expect(applyComposerTextareaHeight(el, "hello")).toBe(96);
    expect(el.style.height).toBe("96px");

    const tall = { style: { height: "52px" }, scrollHeight: 400, clientWidth: 640 };
    expect(applyComposerTextareaHeight(tall, "lots")).toBe(COMPOSER_TEXTAREA_MAX_PX);
    expect(tall.style.height).toBe(`${COMPOSER_TEXTAREA_MAX_PX}px`);
  });
});
