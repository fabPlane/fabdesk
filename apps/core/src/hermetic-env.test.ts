import { describe, expect, spyOn, test } from "bun:test";
import { runHermeticEnv } from "./hermetic-env";
import { delimiter, dirname, resolve } from "node:path";

const baseEnv = {
  PATH: "/usr/bin",
  KICAD_CLI: "/bundle/kicad/bin/kicad-cli",
  KICAD_STOCK_DATA_HOME: "/bundle/kicad/share/kicad",
  KICAD_FOOTPRINT_DIR: "/bundle/footprints",
  KICAD_SYMBOL_DIR: "/bundle/symbols",
  LD_LIBRARY_PATH: "/bundle/kicad/lib",
  FABDESK_TOKEN: "must-not-be-described",
};

describe("hermetic packaged-KiCad environment", () => {
  test("hides the packaged version probe and exec while preserving the exit code", async () => {
    const spawn = spyOn(Bun, "spawn");
    const deps = { env: { ...process.env, KICAD_CLI: process.execPath }, out: () => {} };
    try {
      expect(await runHermeticEnv({ action: "describe" }, deps)).toBe(0);
      const args = ["-e", "process.exit(7)"];
      const name = process.platform === "win32" ? "KiCad-CLI.EXE" : "kicad-cli";
      expect(await runHermeticEnv({ action: "exec", command: [name, ...args] }, deps)).toBe(7);
      expect(spawn).toHaveBeenCalledWith([process.execPath, "--version"], expect.objectContaining({ windowsHide: true }));
      expect(spawn).toHaveBeenCalledWith([process.execPath, ...args], expect.objectContaining({ windowsHide: true }));
    } finally {
      spawn.mockRestore();
    }
  });

  test("preserves the inherited PATH with the platform's environment-key casing", async () => {
    const { PATH, ...rest } = baseEnv;
    let observed: Record<string, string> = {};
    await runHermeticEnv(
      { action: "exec", command: ["kicad-cli", "version"] },
      {
        env: { ...rest, [process.platform === "win32" ? "Path" : "PATH"]: PATH },
        cwd: () => process.cwd(),
        pathExists: async () => true,
        execute: async ({ env }) => {
          observed = env;
          return 0;
        },
      },
    );
    expect(observed.PATH).toBe(`${dirname(baseEnv.KICAD_CLI)}${delimiter}${PATH}`);
    expect(observed.Path).toBeUndefined();
  });

  test("describes exact toolchain paths without exposing credentials", async () => {
    let output = "";
    expect(
      await runHermeticEnv(
        { action: "describe", project: "/project" },
        {
          env: baseEnv,
          cwd: () => "/work",
          pathExists: async () => true,
          version: async () => "10.99.0",
          out: (text) => {
            output += text;
          },
        },
      ),
    ).toBe(0);
    const result = JSON.parse(output) as Record<string, any>;
    expect(result.contract).toEqual({ name: "fabdesk.packaged-kicad-cli", version: "1.1.0" });
    expect(result.project).toBe(resolve("/project"));
    expect(result.executable).toEqual({ kicadCli: baseEnv.KICAD_CLI, version: "10.99.0" });
    expect(result.scope).toEqual({
      packaged: ["kicad-cli"],
      hostCommandsAllowed: true,
      pcbnewPythonPackaged: false,
      guiToolsPackaged: false,
    });
    expect(result.environment.KICAD_STOCK_DATA_HOME).toBe(baseEnv.KICAD_STOCK_DATA_HOME);
    expect(result.environment.FABDESK_TOKEN).toBeUndefined();
    expect(output).not.toContain("must-not-be-described");
  });

  test("labels non-KiCad executables as host commands", async () => {
    let error = "";
    let observed: string[] | undefined;
    expect(
      await runHermeticEnv(
        { action: "exec", command: ["python3", "generate.py"] },
        {
          env: baseEnv,
          cwd: () => "/work",
          pathExists: async () => true,
          execute: async ({ command }) => {
            observed = command;
            return 0;
          },
          err: (text) => {
            error += text;
          },
        },
      ),
    ).toBe(0);
    expect(observed).toEqual(["python3", "generate.py"]);
    expect(error).toContain("host command `python3`");
    expect(error).toContain("nested commands are not isolated");
  });

  test("rejects host KiCad entrypoints inside the packaged CLI scope", async () => {
    const windowsNames = process.platform === "win32"
      ? ["C:\\host\\bin\\KiCAD-CLI.EXE", ".\\tools\\kicad-cli.exe", "PCBNEW.EXE", "Eeschema.Exe", "KiCad.EXE"]
      : [];
    for (const executable of ["/usr/bin/kicad-cli", "pcbnew", "eeschema", "kicad", ...windowsNames]) {
      let error = "";
      expect(
        await runHermeticEnv(
          { action: "exec", command: [executable, "--version"] },
          {
            env: baseEnv,
            cwd: () => "/work",
            pathExists: async () => true,
            execute: async () => {
              throw new Error("must not execute");
            },
            err: (text) => {
              error += text;
            },
          },
        ),
      ).toBe(2);
      expect(error).toContain("not part of the packaged CLI scope");
    }
  });

  test.skipIf(process.platform !== "win32")("resolves a relative KiCad path against the command's project", async () => {
    const project = "C:\\FabDesk Tools";
    const cli = project + "\\bin\\kicad-cli.exe";
    let observed: string[] | undefined;
    expect(await runHermeticEnv(
      { action: "exec", project, command: [".\\BIN\\KiCAD-CLI.EXE", "--version"] },
      {
        env: { KICAD_CLI: cli },
        cwd: () => "C:\\other",
        pathExists: async () => true,
        execute: async ({ command }) => { observed = command; return 0; },
      },
    )).toBe(0);
    expect(observed).toEqual([cli, "--version"]);
  });

  test("executes in the project and resolves kicad-cli to the packaged binary", async () => {
    let observed: { command: string[]; cwd: string; env: Record<string, string> } | undefined;
    expect(
      await runHermeticEnv(
        {
          action: "exec",
          project: "board",
          command: ["kicad-cli", "pcb", "drc", "board.kicad_pcb"],
        },
        {
          env: baseEnv,
          cwd: () => "/work",
          pathExists: async () => true,
          execute: async (input) => {
            observed = input;
            return 7;
          },
        },
      ),
    ).toBe(7);
    expect(observed?.command).toEqual([baseEnv.KICAD_CLI, "pcb", "drc", "board.kicad_pcb"]);
    expect(observed?.cwd).toBe(resolve("/work", "board"));
    expect(observed?.env.PATH).toBe(`${dirname(baseEnv.KICAD_CLI)}${delimiter}/usr/bin`);
    expect(observed?.env.FABDESK_PROJECT_DIR).toBe(resolve("/work", "board"));
    expect(observed?.env.APPDIR).toBeUndefined();
  });

  test("strips AppImage launcher variables before spawning packaged KiCad", async () => {
    let observed: Record<string, string> = {};
    expect(
      await runHermeticEnv(
        { action: "exec", command: ["kicad-cli", "version"] },
        {
          env: {
            ...baseEnv,
            APPDIR: "/tmp/.mount_fabplane",
            APPIMAGE: "/downloads/fabplane.AppImage",
            ARGV0: "./fabplane.AppImage",
            OWD: "/downloads",
          },
          cwd: () => "/work",
          pathExists: async () => true,
          execute: async ({ env }) => {
            observed = env;
            return 0;
          },
        },
      ),
    ).toBe(0);
    expect(observed.APPDIR).toBeUndefined();
    expect(observed.APPIMAGE).toBeUndefined();
    expect(observed.ARGV0).toBeUndefined();
    expect(observed.OWD).toBeUndefined();
    expect(observed.KICAD_CLI).toBe(baseEnv.KICAD_CLI);
  });

  test("fails closed when the packaged executable is unavailable", async () => {
    let error = "";
    expect(
      await runHermeticEnv(
        { action: "describe" },
        {
          env: { PATH: "/usr/bin" },
          cwd: () => "/work",
          pathExists: async () => true,
          err: (text) => {
            error += text;
          },
        },
      ),
    ).toBe(1);
    expect(error).toContain("KICAD_CLI");
  });
});
