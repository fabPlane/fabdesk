/** Method-neutral access to the exact packaged KiCad environment used by Fabdesk. */
import { exists } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

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

The command runs with the packaged KiCad executable, libraries and stock data used by Fabdesk.
"kicad-cli" resolves explicitly to KICAD_CLI. Describe output excludes credentials and tokens.
`;

function environment(source: NodeJS.ProcessEnv, project?: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (typeof value === "string") result[key] = value;
  const cli = source["KICAD_CLI"]?.trim();
  if (cli) result["PATH"] = [dirname(cli), source["PATH"]].filter(Boolean).join(":");
  if (project) result["FABDESK_PROJECT_DIR"] = project;
  return result;
}

function visibleEnvironment(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(EXPOSED_VARIABLES.flatMap((key) => env[key] ? [[key, env[key]]] : []));
}

async function defaultVersion(executable: string, env: Record<string, string>): Promise<string | null> {
  const child = Bun.spawn([executable, "--version"], { env, stdout: "pipe", stderr: "pipe" });
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
    out(`${JSON.stringify({
      contract: { name: "fabdesk.hermetic-environment", version: "1.0.0" },
      project,
      executable: { kicadCli: cli, version },
      environment: visibleEnvironment(env),
    }, null, 2)}\n`);
    return 0;
  }

  if (!options.command?.length) {
    err(`fabpcb env: exec requires a command after --\n${HERMETIC_ENV_USAGE}`);
    return 2;
  }
  const command = [...options.command];
  if (command[0] === "kicad-cli") command[0] = cli;
  return (deps.execute ?? defaultExecute)({ command, cwd: project, env });
}
