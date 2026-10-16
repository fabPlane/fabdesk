import { expect, test } from "bun:test";
import { modelDisplayName } from "./model-display-name";

test("shows actual model versions, removes snapshot dates, and preserves context size", () => {
  expect(modelDisplayName("fable", { fable: "claude-fable-5-1[1m]" })).toBe("Fable 5.1 (1M)");
  expect(modelDisplayName("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  expect(modelDisplayName("claude-opus-5[1m]")).toBe("Opus 5 (1M)");
  expect(modelDisplayName("sonnet-4.5")).toBe("Sonnet 4.5");
  expect(modelDisplayName("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
  expect(modelDisplayName("sonnet")).toBe("Sonnet");
  expect(modelDisplayName("custom-model-v2")).toBe("custom-model-v2");
});
