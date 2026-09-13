import { describe, expect, test } from "bun:test";
import type { CloudSettings, Settings } from "@fabdesk/protocol";
import { patchFromCloud, portableFromSettings } from "../src/cloud-settings";

const settings = {
  kicadCliPath: "/opt/kicad",
  ngspicePath: null,
  fpPcbBridgeUrl: null,
  router: "capacity",
  defaultAgent: "claude",
  defaultRuntimeMode: "full",
  agents: {},
  keepCoreRunning: true,
  webmcpWriteTools: false,
  errorReporting: true,
  theme: "dark",
  remote: { enabled: false, host: "0.0.0.0", port: 47820 },
  notifications: { enabled: true },
} satisfies Settings;

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
