import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodexConfiguredModel, readCodexConfiguredModel } from "./codex-model";

test("Codex model metadata respects selected profile and never picks an inactive profile", () => {
  expect(parseCodexConfiguredModel('model="gpt-6-astra"')).toBe("gpt-6-astra");
  expect(parseCodexConfiguredModel('model="base"\nprofile="fast"\n[profiles.fast]\nmodel="fast-model"')).toBe("fast-model");
  expect(parseCodexConfiguredModel('model="base"\n[profiles.fast]\nmodel="fast-model"')).toBe("base");
  expect(parseCodexConfiguredModel('model="base"\nprofile="fast"\n[profiles.fast]\nmodel_reasoning_effort="low"')).toBe("base");
});

test("absent or invalid configuration stays unknown instead of guessing", () => {
  for (const text of ['', 'model=', 'model=23', 'model=" "', 'profile="missing"\nmodel="base"']) expect(parseCodexConfiguredModel(text)).toBeUndefined();
});

test("Codex home override wins over HOME and configuration is never modified", () => {
  const root = mkdtempSync(join(tmpdir(), "fabdesk-model-"));
  try {
    const custom = join(root, "custom"); mkdirSync(custom);
    mkdirSync(join(root, ".codex"));
    writeFileSync(join(root, ".codex", "config.toml"), 'model="home-model"');
    writeFileSync(join(custom, "config.toml"), 'model="custom-model"');
    expect(readCodexConfiguredModel({ CODEX_HOME: custom, HOME: root })).toBe("custom-model");
    expect(readCodexConfiguredModel({ HOME: root })).toBe("home-model");
    expect(readCodexConfiguredModel({ USERPROFILE: root })).toBe("home-model");
    expect(readCodexConfiguredModel({ CODEX_HOME: join(root, "missing"), HOME: root })).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
