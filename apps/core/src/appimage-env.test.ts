import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { kifaceSearchDir, scrubAppImageRuntimeEnv, withoutAppImageRuntime } from "./appimage-env";

const launcher = {
  APPDIR: "/tmp/.mount_fabplane",
  APPIMAGE: "/downloads/fabplane.AppImage",
  ARGV0: "./fabplane.AppImage",
  OWD: "/downloads",
};
const cli = "/tmp/.mount_fabplane/resources/pcb/kicad/bin/kicad-cli";

describe("AppImage runtime isolation", () => {
  test("drops launcher identity without mutating the source environment", () => {
    const source = { ...launcher, KICAD_CLI: cli };
    expect(withoutAppImageRuntime(source)).toEqual({ KICAD_CLI: cli });
    expect(source.APPDIR).toBe(launcher.APPDIR);
  });

  test("scrubs process-like environments in place so later kicad-cli spawns stay clean", () => {
    const env: NodeJS.ProcessEnv = { ...launcher, PATH: "/usr/bin" };
    expect(scrubAppImageRuntimeEnv(env)).toBe(env);
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("maps a leaked APPDIR to the AppImage usr/bin kiface directory", () => {
    expect(kifaceSearchDir(cli, launcher)).toBe(join(launcher.APPDIR, "usr", "bin"));
    expect(kifaceSearchDir(cli, withoutAppImageRuntime(launcher))).toBe(dirname(cli));
  });
});
