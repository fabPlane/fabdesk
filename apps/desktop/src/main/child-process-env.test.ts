import { describe, expect, test } from "bun:test";
import { sidecarEnvironment } from "./child-process-env";

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
