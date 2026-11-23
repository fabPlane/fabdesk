import { describe, expect, test } from "bun:test";
import { Settings, type CloudSettings } from "@fabdesk/protocol";
import { CloudSettingsSync, patchFromCloud, portableFromSettings } from "../src/cloud-settings";
import type { SettingsRepo } from "../src/db";

const settings = Settings.parse({
  kicadCliPath: "/opt/kicad",
  keepCoreRunning: true,
  errorReporting: true,
  theme: "dark",
  defaultAgent: "claude",
  defaultRuntimeMode: "full",
  uiLocale: "system",
  agentReplyLanguage: "match",
});

describe("portableFromSettings", () => {
  test("drops machine-local fields", () => {
    const cloud = portableFromSettings(settings, 99);
    expect(cloud).toEqual({
      schema: 1,
      updatedAt: 99,
      appearance: "dark",
      defaultAgent: "claude",
      defaultRuntimeMode: "full",
      errorReporting: true,
      notificationsEnabled: true,
      uiLocale: "system",
      agentReplyLanguage: "match",
    });
    expect(JSON.stringify(cloud)).not.toContain("kicad");
    expect(JSON.stringify(cloud)).not.toContain("keepCore");
  });
});

describe("patchFromCloud", () => {
  test("only fills keys the document actually has", () => {
    const cloud: CloudSettings = { schema: 1, updatedAt: 1, appearance: "light" };
    expect(patchFromCloud(cloud)).toEqual({ theme: "light" });
  });
});

describe("CloudSettingsSync", () => {
  function fakeRepo(stamp = 100): SettingsRepo {
    const raw = new Map<string, unknown>([["cloud_updated_at", stamp]]);
    return {
      get: () => Settings.parse({}),
      patch: () => Settings.parse({}),
      readRaw: (k: string) => raw.get(k),
      writeRaw: (k: string, v: unknown) => {
        raw.set(k, v);
      },
    } as unknown as SettingsRepo;
  }

  test("push without a token still advances the stamp so a later sign-in uploads", async () => {
    const settings = fakeRepo(100);
    const sync = new CloudSettingsSync({
      apiOrigin: "https://api.fabplane.test",
      token: () => null,
      settings,
    });
    await sync.push();
    expect(sync.stamp()).toBeGreaterThan(100);
  });

  test("a newer cloud document applies errorReporting at runtime", async () => {
    const applied: boolean[] = [];
    const settings = fakeRepo(1);
    const sync = new CloudSettingsSync({
      apiOrigin: "https://api.fabplane.test",
      token: () => "fpd_ok",
      settings,
      applyErrorReporting: async (enabled) => {
        applied.push(enabled);
      },
      fetchImpl: (async () =>
        Response.json({ schema: 1, updatedAt: 50, errorReporting: false })) as unknown as typeof fetch,
    });
    await sync.pull();
    expect(applied).toEqual([false]);
    expect(sync.stamp()).toBe(50);
  });
});
