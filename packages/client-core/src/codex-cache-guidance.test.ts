import { describe, expect, test } from "bun:test";
import type { AgentInfo } from "@fabdesk/protocol";
import { codexCacheGuidance } from "./codex-cache-guidance";

const agent: AgentInfo = {
  id: "codex",
  displayName: "Codex",
  installed: true,
  path: "/custom/codex",
  version: "0.154.0",
  installHint: "",
  models: ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-sol"],
};

describe("Codex cache version guidance", () => {
  for (const version of ["0.9.0", "0.154.0", "0.161.0", "0.161.99"]) {
    test(`${version} predates the ordinary Responses change`, () => {
      const result = codexCacheGuidance({ ...agent, version }, "gpt-6.2-sol");
      expect(result?.status).toBe("older");
      expect(result?.message).toContain(
        "update that external Codex installation to stable 0.162.0 or later",
      );
      expect(result?.path).toBe("/custom/codex");
    });
  }
  for (const version of ["0.162.0", "0.162.1", "0.171.0", "0.200.0"]) {
    test(`${version} is comparable but does not prove caching`, () => {
      const result = codexCacheGuidance({ ...agent, version }, "gpt-6.2-astra");
      expect(result?.status).toBe("at-or-above");
      expect(result?.message).toContain("does not verify caching or usage savings");
      expect(result?.offerManualGpt61).toBe(false);
    });
  }
  for (const version of [
    undefined,
    "",
    "0.162",
    "v0.162.0",
    "0.162.0-alpha.1",
    "0.171.0+custom",
    "1.0.0",
    "0.0162.0",
    "0.9999999999999999999999.0",
    "not a version",
  ]) {
    test(`${version ?? "missing version"} remains unknown`, () => {
      const { version: _, ...withoutVersion } = agent;
      const result = codexCacheGuidance(
        version === undefined ? withoutVersion : { ...agent, version },
        "gpt-6.2-sol",
      );
      expect(result?.status).toBe("unknown");
      expect(result?.message).toContain("could not be compared");
    });
  }
  test("a version without a resolved executable path is not used as proof", () => {
    const { path: _, ...withoutPath } = agent;
    expect(codexCacheGuidance({ ...withoutPath, version: "0.171.0" }, "gpt-6.2-sol")?.status).toBe(
      "unknown",
    );
  });
  test("only exact affected IDs on an installed Codex provider qualify", () => {
    for (const model of [
      "gpt-6.1-sol",
      "gpt-6.2-terra",
      "gpt-6.2-sol-preview",
      "gpt-6.2-astra-custom",
      "GPT-6.2-sol",
      " gpt-6.2-sol",
      "",
    ]) {
      expect(codexCacheGuidance(agent, model)).toBeUndefined();
    }
    expect(codexCacheGuidance({ ...agent, id: "claude" }, "gpt-6.2-sol")).toBeUndefined();
    expect(codexCacheGuidance({ ...agent, installed: false }, "gpt-6.2-sol")).toBeUndefined();
    expect(codexCacheGuidance(undefined, "gpt-6.2-sol")).toBeUndefined();
  });
  test("a retained affected selection still gets guidance; alternatives require actual availability", () => {
    expect(codexCacheGuidance({ ...agent, models: [] }, "gpt-6.2-sol")?.status).toBe("older");
    expect(codexCacheGuidance({ ...agent, models: [] }, "gpt-6.2-sol")?.offerManualGpt61).toBe(
      false,
    );
    expect(
      codexCacheGuidance({ ...agent, models: ["gpt-6.1-sol-custom"] }, "gpt-6.2-sol")
        ?.offerManualGpt61,
    ).toBe(false);
    expect(codexCacheGuidance(agent, "gpt-6.2-sol")?.offerManualGpt61).toBe(true);
    const before = JSON.stringify(agent);
    codexCacheGuidance(agent, "gpt-6.2-sol");
    expect(JSON.stringify(agent)).toBe(before);
  });
});
