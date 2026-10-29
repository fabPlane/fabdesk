import { expect, test } from "bun:test";
import { parseCodexModelCatalog } from "./codex-models";

test("installed Codex catalog uses actual model IDs, excluding hidden and malformed entries", () => {
  expect(parseCodexModelCatalog({ data: [
    { id: "display-only-id", model: "available-model", isDefault: true, account: "ignored" },
    { model: "available-model" }, { model: "older-model" },
    { model: "hidden-model", hidden: true, isDefault: true },
    { id: "missing-model" }, null, { model: 4 }, { model: " " },
  ], instructions: "ignored" })).toEqual({ models: ["available-model", "older-model"], defaultModel: "available-model" });
});

test("unavailable or empty catalog stays unknown so detection can retain its fallback", () => {
  for (const value of [null, {}, { data: {} }, { data: [] }, { data: [{ model: "hidden", hidden: true }] }]) {
    expect(parseCodexModelCatalog(value)).toBeUndefined();
  }
  expect(parseCodexModelCatalog({ data: [{ model: "usable" }] })).toEqual({ models: ["usable"] });
});
