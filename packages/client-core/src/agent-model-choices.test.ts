import { describe, expect, test } from "bun:test";
import { agentModelLabel, pickerModelChoices } from "./agent-model-choices";

describe("pickerModelChoices", () => {
  const available = ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4"];

  test("caps the adapter list at three when nothing is configured", () => {
    expect(pickerModelChoices(available, [])).toEqual(["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"]);
  });

  test("configured models replace the default three, in the configured order, and may exceed three", () => {
    expect(pickerModelChoices(available, ["gpt-5.4", "gpt-5.5", "custom-x", "gpt-5.6-luna"])).toEqual(["gpt-5.4", "gpt-5.5", "custom-x", "gpt-5.6-luna"]);
  });

  test("drops blanks and duplicates", () => {
    expect(pickerModelChoices(available, ["a", "", "a", "b"])).toEqual(["a", "b"]);
  });

  test("keeps the current model visible even when it is not listed", () => {
    expect(pickerModelChoices(available, [], "gpt-5.4")).toEqual(["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.4"]);
    expect(pickerModelChoices(available, [], "gpt-5.5")).toEqual(["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra"]);
  });
});

describe("agentModelLabel", () => {
  test("name only on the default model, name · model otherwise", () => {
    expect(agentModelLabel({ displayName: "Codex" }, "codex", "")).toBe("Codex");
    expect(agentModelLabel({ displayName: "Codex" }, "codex", "gpt-5.5")).toBe("Codex · gpt-5.5");
    expect(agentModelLabel(undefined, "grok", "")).toBe("grok");
  });
});
