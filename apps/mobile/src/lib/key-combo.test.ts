import { describe, expect, test } from "bun:test";
import { normalizeCombo, parseCombo } from "./key-combo";

describe("parseCombo", () => {
  test("splits modifiers from the key", () => {
    expect(parseCombo("cmd+n")).toEqual({ key: "n", modifiers: ["cmd"] });
    expect(parseCombo("cmd+shift+k")).toEqual({ key: "k", modifiers: ["shift", "cmd"] });
    expect(parseCombo("n")).toEqual({ key: "n", modifiers: [] });
  });

  test("accepts aliases and any case or spacing", () => {
    expect(parseCombo(" Command + N ")).toEqual({ key: "n", modifiers: ["cmd"] });
    expect(parseCombo("meta+option+control+shift+x")).toEqual({
      key: "x",
      modifiers: ["ctrl", "alt", "shift", "cmd"],
    });
    expect(parseCombo("cmd+return")).toEqual({ key: "enter", modifiers: ["cmd"] });
    expect(parseCombo("Esc")).toEqual({ key: "escape", modifiers: [] });
  });

  test("rejects nonsense", () => {
    expect(parseCombo("")).toBeNull();
    expect(parseCombo("+")).toBeNull();
    expect(parseCombo("cmd")).toBeNull();
    expect(parseCombo("cmd+shift")).toBeNull();
    expect(parseCombo("cmd+n+k")).toBeNull();
    expect(parseCombo("cmd+foo")).toBeNull();
  });
});

describe("normalizeCombo", () => {
  test("produces one spelling for every equivalent input", () => {
    expect(normalizeCombo("N+Cmd")).toBe("cmd+n");
    expect(normalizeCombo("shift+cmd+k")).toBe("shift+cmd+k");
    expect(normalizeCombo("cmd+shift+k")).toBe("shift+cmd+k");
    expect(normalizeCombo("cmd+cmd+k")).toBe("cmd+k");
    expect(normalizeCombo("cmd+enter")).toBe("cmd+enter");
  });

  test("is null for an unparsable combo", () => {
    expect(normalizeCombo("cmd")).toBeNull();
  });
});
