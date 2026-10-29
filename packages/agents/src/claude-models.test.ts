import { expect, test } from "bun:test";
import { parseClaudeModelCatalog } from "./claude-models";

const response = (models: unknown) => ({ type: "control_response", response: { subtype: "success", request_id: "fabdesk-model-catalog", response: { models } } });

test("effort capabilities resolve defaults and aliases without inventing support", () => {
  const result = parseClaudeModelCatalog(response([
    { value: "default", resolvedModel: "claude-opus-test", supportsEffort: true, supportedEffortLevels: ["low", "high", "invalid"] },
    { value: "opus[1m]", resolvedModel: "claude-opus-test", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
    { value: "haiku", resolvedModel: "claude-haiku-test" },
  ]));
  expect(result?.modelEfforts).toEqual({ default: ["low", "high"], "claude-opus-test": ["low", "high"], "opus[1m]": ["low", "high"], opus: ["low", "high"] });
  expect(result?.modelEfforts?.haiku).toBeUndefined();
});

test("uses CLI-resolved versions while retaining selectable IDs", () => {
  const result = parseClaudeModelCatalog(response([
    { value: "default", resolvedModel: "claude-opus-5[1m]" },
    { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]" },
    { value: "sonnet", resolvedModel: "claude-sonnet-5" },
    { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1[1m]" },
  ]));
  expect(result?.models).toEqual(["opus[1m]", "sonnet", "claude-fable-5-1[1m]"]);
  expect(result?.defaultModel).toBe("claude-opus-5[1m]");
  expect(result?.modelAliases.fable).toBe("claude-fable-5-1[1m]");
  expect(result?.modelAliases.sonnet).toBe("claude-sonnet-5");
});

test("ignores invalid or unrelated control responses instead of inventing versions", () => {
  for (const value of [null, {}, response(null), response([null, {}, { value: "sonnet" }]), { type: "control_response", response: { subtype: "error" } }]) expect(parseClaudeModelCatalog(value)).toBeUndefined();
});
