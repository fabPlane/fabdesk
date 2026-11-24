/** Method-neutral access to the exact packaged KiCad CLI used by Fabdesk. */
import { exists } from "node:fs/promises";
import { basename, delimiter, dirname, isAbsolute, resolve } from "node:path";
import { withoutAppImageRuntime } from "./appimage-env";

const EXPOSED_VARIABLES = [
  "KICAD_CLI",
  "KICAD_STOCK_DATA_HOME",
  "KICAD_FOOTPRINT_DIR",
  "KICAD_SYMBOL_DIR",
  "KICAD10_FOOTPRINT_DIR",
  "KICAD10_SYMBOL_DIR",
  "LD_LIBRARY_PATH",
  "FABDESK_FP_PCB_BRIDGE_URL",
  "FABDESK_CORE_URL",
  "FABDESK_PROJECTS_DIR",
  "FABDESK_PROJECT_DIR",
  "FABDESK_RUNTIME_ID",
] as const;

export type HermeticEnvOptions = {
  action?: "describe" | "exec";
  project?: string;
  command?: string[];
};

type HermeticEnvDeps = {
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  pathExists?: (path: string) => Promise<boolean>;
  version?: (executable: string, env: Record<string, string>) => Promise<string | null>;
  execute?: (input: {
    command: string[];
    cwd: string;
    env: Record<string, string>;
  }) => Promise<number>;
  out?: (text: string) => void;
  err?: (text: string) => void;
};

export const HERMETIC_ENV_USAGE = `Usage:
  fabpcb env describe [--project <dir>]
  fabpcb env exec [--project <dir>] -- <command> [arguments...]

Bare "kicad-cli" resolves explicitly to Fabdesk's packaged executable and data.
Other commands remain host commands; this interface does not provide packaged pcbnew Python or GUI tools.
Describe output excludes credentials and tokens.
`;

const HOST_KICAD_ENTRYPOINTS = new Set(["eeschema", "kicad", "pcbnew"]);

function resolveCommand(
  requested: string[],
  packagedCli: string,
): { command?: string[]; error?: string; hostCommand?: string } {
  const command = [...requested];
  const executable = command[0]!;
  const packagedWindowsCli =
    process.platform === "win32" &&
    (/^kicad-cli(?:\.exe)?$/i.test(executable) ||
      (isAbsolute(executable) && resolve(executable).toLowerCase() === resolve(packagedCli).toLowerCase()));
  if (executable === "kicad-cli" || executable === packagedCli || packagedWindowsCli) {
    command[0] = packagedCli;
    return { command };
  }

  const name = basename(executable);
  if (name === "kicad-cli" || HOST_KICAD_ENTRYPOINTS.has(name)) {
    return {
      error: `fabpcb env: ${executable} is not part of the packaged CLI scope; use bare \`kicad-cli\` or run the host tool outside \`fabpcb env exec\`\n`,
    };
  }

  return { command, hostCommand: executable };
}

function environment(source: NodeJS.ProcessEnv, project?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(withoutAppImageRuntime(source)))
    if (typeof value === "string")
      result[process.platform === "win32" ? key.toUpperCase() : key] = value;
  const cli = result["KICAD_CLI"]?.trim();
  if (cli) result["PATH"] = [dirname(cli), result["PATH"]].filter(Boolean).join(delimiter);
  if (project) result["FABDESK_PROJECT_DIR"] = project;
  return result;
}

function visibleEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    EXPOSED_VARIABLES.flatMap((key) => (env[key] ? [[key, env[key]]] : [])),
  );
}

async function defaultVersion(
  executable: string,
  env: Record<string, string>,
): Promise<string | null> {
  const child = Bun.spawn([executable, "--version"], { env, windowsHide: true, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) return null;
  return (stdout || stderr).trim() || null;
}

async function defaultExecute(input: {
  command: string[];
  cwd: string;
  env: Record<string, string>;
}): Promise<number> {
  const child = Bun.spawn(input.command, {
    cwd: input.cwd,
    env: input.env,
    windowsHide: input.command[0] === input.env["KICAD_CLI"]?.trim(),
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
}

export async function runHermeticEnv(
  options: HermeticEnvOptions,
  deps: HermeticEnvDeps = {},
): Promise<number> {
  const source = deps.env ?? process.env;
  const currentDirectory = (deps.cwd ?? process.cwd)();
  const project = options.project ? resolve(currentDirectory, options.project) : currentDirectory;
  const env = environment(source, project);
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const pathExists = deps.pathExists ?? (async (path: string) => exists(path));
  const cli = env["KICAD_CLI"]?.trim();

  if (!cli || !isAbsolute(cli) || !(await pathExists(cli))) {
    err("fabpcb env: KICAD_CLI does not identify an existing absolute packaged executable\n");
    return 1;
  }
  if (!(await pathExists(project))) {
    err(`fabpcb env: project directory does not exist: ${project}\n`);
    return 1;
  }

  if ((options.action ?? "describe") === "describe") {
    const version = await (deps.version ?? defaultVersion)(cli, env);
    out(
      `${JSON.stringify(
        {
          contract: { name: "fabdesk.packaged-kicad-cli", version: "1.1.0" },
          project,
          executable: { kicadCli: cli, version },
          scope: {
            packaged: ["kicad-cli"],
            hostCommandsAllowed: true,
            pcbnewPythonPackaged: false,
            guiToolsPackaged: false,
          },
          environment: visibleEnvironment(env),
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  if (!options.command?.length) {
    err(`fabpcb env: exec requires a command after --\n${HERMETIC_ENV_USAGE}`);
    return 2;
  }
  const resolved = resolveCommand(options.command, cli);
  if (resolved.error) {
    err(resolved.error);
    return 2;
  }
  if (resolved.hostCommand) {
    err(
      `fabpcb env: host command \`${resolved.hostCommand}\`; only bare \`kicad-cli\` is supplied by Fabdesk (nested commands are not isolated)\n`,
    );
  }
  return (deps.execute ?? defaultExecute)({ command: resolved.command!, cwd: project, env });
}
