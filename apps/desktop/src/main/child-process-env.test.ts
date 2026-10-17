import { describe, expect, test } from "bun:test";
import { coreEnvironment, sidecarEnvironment } from "./child-process-env";

describe("sidecar environment", () => {
  test("removes AppImage launcher identity while preserving packaged runtime paths", () => {
    expect(
      sidecarEnvironment(
        {
          APPDIR: "/tmp/.mount_fabplane",
          APPIMAGE: "/downloads/fabplane.AppImage",
          ARGV0: "./fabplane.AppImage",
          OWD: "/downloads",
          PATH: "/usr/bin",
        },
        {
          KICAD_CLI: "/tmp/.mount_fabplane/resources/pcb/kicad/bin/kicad-cli",
          LD_LIBRARY_PATH: "/tmp/.mount_fabplane/resources/pcb/kicad/lib",
        },
      ),
    ).toEqual({
      PATH: "/usr/bin",
      KICAD_CLI: "/tmp/.mount_fabplane/resources/pcb/kicad/bin/kicad-cli",
      LD_LIBRARY_PATH: "/tmp/.mount_fabplane/resources/pcb/kicad/lib",
    });
  });
});

describe("core environment", () => {
  test("activates uploads for an ordinary packaged launch without changing its parent", () => {
    const base = { PATH: "/usr/bin", APPIMAGE: "/downloads/fabplane.AppImage" };
    const extra = { FABDESK_TOKEN: "test-token", ELECTRON_RUN_AS_NODE: undefined };
    expect(coreEnvironment(base, extra, true)).toEqual({
      PATH: "/usr/bin",
      FABDESK_TOKEN: "test-token",
      ELECTRON_RUN_AS_NODE: undefined,
      FABDESK_USAGE_REMOTE_BACKUP: "1",
    });
    expect(base).toEqual({ PATH: "/usr/bin", APPIMAGE: "/downloads/fabplane.AppImage" });
    expect(extra).not.toHaveProperty("FABDESK_USAGE_REMOTE_BACKUP");
  });

  test("leaves development launches and packaged development profiles off by default", () => {
    expect(coreEnvironment({}, {}, false)).not.toHaveProperty("FABDESK_USAGE_REMOTE_BACKUP");
  });

  test.each(["0", "1", "", "false"])("preserves an explicit operator value %j", (value) => {
    expect(coreEnvironment({ FABDESK_USAGE_REMOTE_BACKUP: value }, {}, true)).toHaveProperty(
      "FABDESK_USAGE_REMOTE_BACKUP",
      value,
    );
  });

  test("allows development uploads when explicitly enabled", () => {
    expect(coreEnvironment({ FABDESK_USAGE_REMOTE_BACKUP: "1" }, {}, false)).toHaveProperty(
      "FABDESK_USAGE_REMOTE_BACKUP",
      "1",
    );
  });

  test("honors a launch override over the inherited value", () => {
    expect(
      coreEnvironment(
        { FABDESK_USAGE_REMOTE_BACKUP: "1" },
        { FABDESK_USAGE_REMOTE_BACKUP: "0" },
        true,
      ),
    ).toHaveProperty("FABDESK_USAGE_REMOTE_BACKUP", "0");
  });
});
