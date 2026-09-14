import { describe, expect, test } from "bun:test";
import type { AgentInfo } from "@fabdesk/protocol";
import {
  agentOptions,
  choiceLabel,
  choicePatch,
  modelOptions,
  parseStoredChoice,
  resolveAgentChoice,
  sameChoice,
  serializeChoice,
} from "./agent-choice";

const agent = (id: AgentInfo["id"], installed = true, models: string[] = []): AgentInfo => ({
  id,
  displayName: id[0]!.toUpperCase() + id.slice(1),
  installed,
  installHint: "",
  models,
});

const agents = [
  agent("claude", true, ["opus", "sonnet", "haiku", "legacy"]),
  agent("codex", true, ["gpt-5"]),
  agent("cursor", false),
];

describe("resolveAgentChoice", () => {
  test("prefers what this phone used last when that agent is still installed", () => {
    const remembered = { agentId: "codex" as const, model: "gpt-5" };
    expect(
      resolveAgentChoice({ agents, settings: { defaultAgent: "claude" }, remembered }),
    ).toEqual(remembered);
  });

  test("drops a remembered agent that is not installed on this computer", () => {
    const out = resolveAgentChoice({
      agents,
      settings: { defaultAgent: "claude", agents: { claude: { model: "sonnet" } } },
      remembered: { agentId: "cursor", model: "" },
    });
    expect(out).toEqual({ agentId: "claude", model: "sonnet" });
  });

  test("trusts a remembered choice while the agent list is still loading", () => {
    const remembered = { agentId: "grok" as const, model: "" };
    expect(resolveAgentChoice({ agents: undefined, settings: undefined, remembered })).toEqual(
      remembered,
    );
  });

  test("falls back to the desktop's default agent, then the first installed one", () => {
    expect(
      resolveAgentChoice({ agents, settings: { defaultAgent: "codex" }, remembered: null }),
    ).toEqual({
      agentId: "codex",
      model: "",
    });
    expect(
      resolveAgentChoice({ agents, settings: { defaultAgent: "cursor" }, remembered: null }),
    ).toEqual({
      agentId: "claude",
      model: "",
    });
    expect(resolveAgentChoice({ agents: [], settings: undefined, remembered: null })).toEqual({
      agentId: "claude",
      model: "",
    });
  });
});

describe("options", () => {
  test("agentOptions lists installed agents only and ticks the current one", () => {
    const out = agentOptions(agents, { agentId: "codex", model: "" });
    expect(out.map((o) => o.agentId)).toEqual(["claude", "codex"]);
    expect(out.map((o) => o.selected)).toEqual([false, true]);
  });

  test("modelOptions puts the default first, then the desktop's picker list without repeating it", () => {
    const out = modelOptions(
      agents[0]!,
      { agents: { claude: { model: "sonnet", pickerModels: ["opus", "sonnet"] } } },
      {
        agentId: "claude",
        model: "",
      },
    );
    expect(out.map((o) => o.model)).toEqual(["sonnet", "opus"]);
    expect(out[0]).toMatchObject({ label: "Default model", hint: "sonnet", selected: true });
  });

  test("modelOptions keeps the thread's current model visible even when it is not offered", () => {
    const out = modelOptions(agents[0]!, undefined, { agentId: "claude", model: "legacy" });
    expect(out.map((o) => o.model)).toEqual(["", "opus", "sonnet", "haiku", "legacy"]);
    expect(out.find((o) => o.model === "legacy")?.selected).toBe(true);
    expect(out[0]!.selected).toBe(false);
  });

  test("modelOptions for a different agent than the current one ticks nothing", () => {
    const out = modelOptions(agents[1]!, undefined, { agentId: "claude", model: "" });
    expect(out.some((o) => o.selected)).toBe(false);
  });
});

describe("labels and wire shape", () => {
  test("choiceLabel", () => {
    expect(choiceLabel({ agentId: "claude", model: "haiku" })).toBe("claude · haiku");
    expect(choiceLabel({ agentId: "claude", model: "" })).toBe("claude");
  });

  test("choicePatch clears the model with null so the daemon falls back to the agent default", () => {
    expect(choicePatch({ agentId: "codex", model: "" })).toEqual({ agentId: "codex", model: null });
    expect(choicePatch({ agentId: "codex", model: "gpt-5" })).toEqual({
      agentId: "codex",
      model: "gpt-5",
    });
  });

  test("sameChoice", () => {
    expect(sameChoice({ agentId: "claude", model: "" }, { agentId: "claude", model: "" })).toBe(
      true,
    );
    expect(sameChoice({ agentId: "claude", model: "" }, { agentId: "claude", model: "x" })).toBe(
      false,
    );
    expect(sameChoice(null, { agentId: "claude", model: "" })).toBe(false);
  });
});

describe("stored choice", () => {
  test("round-trips", () => {
    const c = { agentId: "codex" as const, model: "gpt-5" };
    expect(parseStoredChoice(serializeChoice(c))).toEqual(c);
  });

  test("rejects garbage and unknown agents", () => {
    expect(parseStoredChoice(null)).toBeNull();
    expect(parseStoredChoice("{")).toBeNull();
    expect(parseStoredChoice(JSON.stringify({ agentId: "gemini", model: "" }))).toBeNull();
    expect(parseStoredChoice(JSON.stringify({ agentId: "claude", model: 3 }))).toEqual({
      agentId: "claude",
      model: "",
    });
  });
});
