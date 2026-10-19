import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import {
  coreEnvironment,
  kifaceSearchDir,
  sidecarCommand,
  sidecarEnvironment,
  spawnSidecar,
} from "./child-process-env";

const launcher = {
  APPDIR: "/tmp/.mount_fabplane",
  APPIMAGE: "/downloads/fabplane.AppImage",
  ARGV0: "./fabplane.AppImage",
  OWD: "/downloads",
};
const packaged = {
  KICAD_CLI: "/tmp/.mount_fabplane/resources/pcb/kicad/bin/kicad-cli",
  LD_LIBRARY_PATH: "/tmp/.mount_fabplane/resources/pcb/kicad/lib",
};

function childLauncherEnv(env: NodeJS.ProcessEnv): Promise<Record<string, string | undefined>> {
  return new Promise((resolve, reject) => {
    const child = spawnSidecar(
      process.execPath,
      [
        "-e",
        "process.stdout.write(JSON.stringify({APPDIR:process.env.APPDIR,APPIMAGE:process.env.APPIMAGE,ARGV0:process.env.ARGV0,OWD:process.env.OWD}))",
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      err += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`child exited ${code}: ${err || out}`));
      else resolve(JSON.parse(out) as Record<string, string | undefined>);
    });
  });
}

describe("sidecar environment", () => {
  test("removes AppImage launcher identity while preserving packaged runtime paths", () => {
    expect(
      sidecarEnvironment(
        {
          ...launcher,
          PATH: "/usr/bin",
          ELECTRON_RUN_AS_NODE: "1",
        },
        packaged,
      ),
    ).toEqual({
      PATH: "/usr/bin",
      ...packaged,
    });
  });

  test("KiCad kiface search follows APPDIR when leaked and the bundled cli otherwise", () => {
    const cli = packaged.KICAD_CLI;
    expect(kifaceSearchDir(cli, launcher)).toBe(join(launcher.APPDIR, "usr", "bin"));
    expect(kifaceSearchDir(cli, { APPDIR: "" })).toBe(join("", "usr", "bin"));
    expect(kifaceSearchDir(cli, sidecarEnvironment(launcher, packaged))).toBe(dirname(cli));
  });

  test("does not wrap sidecars in /usr/bin/env -u; AppImage keys are scrubbed on the env object", () => {
    expect(sidecarCommand("/opt/bridge", ["start"])).toEqual({
      command: "/opt/bridge",
      args: ["start"],
    });
    expect(sidecarCommand("C:\\bridge.exe", [])).toEqual({
      command: "C:\\bridge.exe",
      args: [],
    });
  });

  test("spawned sidecar children do not observe AppImage launcher variables", async () => {
    const observed = await childLauncherEnv({
      ...process.env,
      ...launcher,
      ...packaged,
    });
    expect(observed).toEqual({
      APPDIR: undefined,
      APPIMAGE: undefined,
      ARGV0: undefined,
      OWD: undefined,
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
