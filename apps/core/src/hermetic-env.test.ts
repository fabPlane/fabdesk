import { describe, expect, test } from "bun:test";
import { runHermeticEnv } from "./hermetic-env";

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
    expect(result.project).toBe("/project");
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
    for (const executable of ["/usr/bin/kicad-cli", "pcbnew", "eeschema", "kicad"]) {
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
    expect(observed?.cwd).toBe("/work/board");
    expect(observed?.env.PATH).toBe("/bundle/kicad/bin:/usr/bin");
    expect(observed?.env.FABDESK_PROJECT_DIR).toBe("/work/board");
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
