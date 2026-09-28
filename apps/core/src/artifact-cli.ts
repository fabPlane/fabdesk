/** Shell-facing verification/render/release commands over the common Fabdesk kernel. */
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { inspectProjectRevision } from "./project-revisions";

export type ArtifactCliOptions = {
  action: "verify" | "render" | "release";
  project?: string;
  request?: string;
  document?: "schematic" | "pcb";
  baseUrl?: string;
  token?: string;
};

type ArtifactCliDeps = {
  env?: NodeJS.ProcessEnv;
  cwd?: () => string;
  fetch?: typeof fetch;
  readText?: (path: string) => Promise<string>;
  inspect?: typeof inspectProjectRevision;
  out?: (text: string) => void;
  err?: (text: string) => void;
};

export const ARTIFACT_CLI_USAGE = `Usage:
  fabpcb verify --project <dir>
  fabpcb render --project <dir> [--document schematic|pcb] [--request @render.json]
  fabpcb release --project <dir> --request @release.json

Each command requires a clean accepted source revision before and after it runs. Verify executes
the applicable ERC, DRC/parity and gate checks. Render and release use the same kernel as Fabdesk,
without exposing or selecting MCP construction tools.
`;

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function requestObject(
  value: string | undefined,
  readText?: (path: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  if (!value) return {};
  const text = value.startsWith("@")
    ? await (readText ?? ((path) => readFile(path, "utf8")))(resolve(value.slice(1)))
    : value;
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("request must be a JSON object");
  return parsed as Record<string, unknown>;
}

export async function runArtifactCli(
  options: ArtifactCliOptions,
  deps: ArtifactCliDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const out = deps.out ?? ((text: string) => process.stdout.write(text));
  const err = deps.err ?? ((text: string) => process.stderr.write(text));
  const project = resolve((deps.cwd ?? process.cwd)(), options.project ?? ".");
  const baseUrl = options.baseUrl ?? env["FABDESK_CORE_URL"];
  const token = options.token ?? env["FABDESK_TOKEN"];
  if (!baseUrl || !token) {
    err("fabpcb: FABDESK_CORE_URL and FABDESK_TOKEN are required for verify/render/release\n");
    return 2;
  }
  try {
    const inspect = deps.inspect ?? inspectProjectRevision;
    const before = await inspect(project);
    if (!before.accepted)
      throw new Error("project has no accepted revision; run `fabpcb revision accept` first");
    if (!before.clean)
      throw new Error(`working source differs from accepted revision ${before.accepted}`);

    const fetchImpl = deps.fetch ?? fetch;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await fetchImpl(new URL(`/tools/${name}?sync=1`, baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({ ...args, project }),
      });
      const body = (await response
        .json()
        .catch(() => ({ error: `HTTP ${response.status}` }))) as Record<string, unknown>;
      return { name, httpStatus: response.status, ...body };
    };

    const results: Array<Record<string, unknown>> = [];
    if (options.action === "verify") {
      const hasSchematic = await exists(resolve(project, "board.kicad_sch"));
      const hasBoard = await exists(resolve(project, "board.kicad_pcb"));
      if (!hasSchematic && !hasBoard) throw new Error("no native schematic or PCB is present");
      if (hasSchematic) results.push(await call("verify_erc", { severity: "all", limit: 200 }));
      if (hasBoard)
        results.push(
          await call("verify_drc", {
            severity: "all",
            schematicParity: hasSchematic,
            limit: 200,
          }),
        );
      if (hasBoard)
        results.push(
          await call("verify_gate", { requireErc: hasSchematic, acceptWarnings: false }),
        );
    } else if (options.action === "render") {
      const request = await requestObject(options.request, deps.readText);
      results.push(
        await call("render_view", {
          document: options.document ?? "pcb",
          ...request,
        }),
      );
    } else {
      if (!options.request)
        throw new Error(`release requires --request @release.json\n${ARTIFACT_CLI_USAGE}`);
      results.push(
        await call("release_build", await requestObject(options.request, deps.readText)),
      );
    }

    const after = await inspect(project);
    const stable =
      after.clean && after.accepted === before.accepted && after.current === before.current;
    const failed = results.some(
      (result) =>
        Number(result["httpStatus"] ?? 500) >= 400 ||
        result["isError"] === true ||
        result["ok"] === false,
    );
    const output = {
      contract: { name: "fabdesk.accepted-artifact-operation", version: "1.0.0" },
      operation: options.action,
      project,
      acceptedRevision: before.accepted,
      stable,
      pass: stable && !failed,
      results,
      ...(stable ? {} : { failure: "accepted source revision changed during operation" }),
    };
    out(`${JSON.stringify(output, null, 2)}\n`);
    return output.pass ? 0 : 1;
  } catch (error) {
    err(`fabpcb ${options.action}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
