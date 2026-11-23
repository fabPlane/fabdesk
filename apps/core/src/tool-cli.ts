import { capabilityScore } from "@fabdesk/tools";
/** Script-friendly search/describe/call access to the live Fabdesk tool registry. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolManifestEntry } from "@fabdesk/protocol";

export type ToolCliOptions = {
  action?: "search" | "describe" | "call" | "batch";
  query?: string;
  name?: string;
  request?: string;
  input?: string;
  project?: string;
  baseUrl?: string;
  token?: string;
  limit?: number;
};

export const TOOL_CLI_USAGE = `Usage:
  fabpcb tool search <words> [--limit 8]
  fabpcb tool describe <name>
  fabpcb tool call <name> [--request '<json>' | --request @file.json]
  fabpcb tool batch --input @calls.jsonl

Each batch line is {"name":"pcb_inspect","arguments":{...}}. Output is JSON or JSONL.
Defaults: FABDESK_CORE_URL, FABDESK_TOKEN, FABDESK_PROJECT_DIR.
`;

type ToolCliDeps = { fetch?: typeof fetch; readText?: (path: string) => Promise<string> };

export async function runToolCli(options: ToolCliOptions, deps: ToolCliDeps = {}): Promise<number> {
  const baseUrl = options.baseUrl ?? process.env["FABDESK_CORE_URL"];
  const token = options.token ?? process.env["FABDESK_TOKEN"];
  const project = options.project ?? process.env["FABDESK_PROJECT_DIR"];
  if (!baseUrl || !token)
    return writeJson({ ok: false, error: "FABDESK_CORE_URL and FABDESK_TOKEN are required" }, 2);
  const fetchImpl = deps.fetch ?? fetch;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const unavailable = { ok: false, code: "endpoint_unavailable", error: "Cannot reach the active desktop tool endpoint. A network-isolated shell can block loopback access; use MCP capability_search/capability_call or direct MCP tools instead of retrying the same endpoint." };
  const manifestResponse = await fetchImpl(new URL("/tools/manifest", baseUrl), { headers }).catch(() => null);
  if (!manifestResponse) return writeJson(unavailable, 1);
  if (!manifestResponse.ok)
    return writeJson({ ok: false, error: `tool manifest HTTP ${manifestResponse.status}` }, 1);
  const manifest = (await manifestResponse.json()) as ToolManifestEntry[];

  if (options.action === "search") {
    const query = options.query?.trim() ?? "";
    if (!query)
      return writeJson({ ok: false, error: `search requires words\n${TOOL_CLI_USAGE}` }, 2);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = manifest
      .map((tool) => ({
        tool,
        score: capabilityScore(query, tool),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, options.limit ?? 8)
      .map(({ tool }) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        longRunning: tool.longRunning,
      }));
    return writeJson({ ok: true, query, count: matches.length, matches }, 0);
  }

  if (options.action === "describe") {
    const tool = manifest.find((entry) => entry.name === options.name);
    return tool
      ? writeJson({ ok: true, tool }, 0)
      : writeJson({ ok: false, error: `unknown tool ${options.name ?? ""}` }, 1);
  }

  const call = async (name: string, supplied: Record<string, unknown>) => {
    const tool = manifest.find((entry) => entry.name === name);
    if (!tool) return { ok: false, name, status: 404, error: `unknown tool ${name}` };
    const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
    const body = {
      ...supplied,
      ...(project && supplied["project"] === undefined && properties?.["project"]
        ? { project }
        : {}),
    };
    const response = await fetchImpl(
      new URL(`/tools/${encodeURIComponent(name)}?sync=1`, baseUrl),
      { method: "POST", headers, body: JSON.stringify(body) },
    ).catch(() => null);
    if (!response) return { name, ...unavailable };
    const value = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
    return { name, status: response.status, ...(value as Record<string, unknown>) };
  };

  if (options.action === "call") {
    if (!options.name)
      return writeJson({ ok: false, error: `call requires a tool name\n${TOOL_CLI_USAGE}` }, 2);
    const request = await parseObject(options.request ?? "{}", deps.readText);
    const result = await call(options.name, request);
    return writeJson(result, result["ok"] === true ? 0 : 1);
  }

  if (options.action === "batch") {
    const text = await readInput(options.input, deps.readText);
    let failed = false;
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let item: unknown;
      try {
        item = JSON.parse(line);
      } catch (error) {
        failed = true;
        process.stdout.write(
          `${JSON.stringify({ ok: false, line: index + 1, error: error instanceof Error ? error.message : String(error) })}\n`,
        );
        continue;
      }
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        typeof (item as Record<string, unknown>)["name"] !== "string"
      ) {
        failed = true;
        process.stdout.write(
          `${JSON.stringify({ ok: false, line: index + 1, error: "expected {name, arguments}" })}\n`,
        );
        continue;
      }
      const record = item as Record<string, unknown>;
      const args =
        record["arguments"] &&
        typeof record["arguments"] === "object" &&
        !Array.isArray(record["arguments"])
          ? (record["arguments"] as Record<string, unknown>)
          : {};
      const result = await call(String(record["name"]), args);
      if (result["ok"] !== true) failed = true;
      process.stdout.write(`${JSON.stringify({ line: index + 1, ...result })}\n`);
    }
    return failed ? 1 : 0;
  }

  return writeJson({ ok: false, error: TOOL_CLI_USAGE }, 2);
}

async function parseObject(
  value: string,
  readText?: (path: string) => Promise<string>,
): Promise<Record<string, unknown>> {
  const parsed = JSON.parse(
    value.startsWith("@")
      ? await (readText ?? ((path) => readFile(path, "utf8")))(resolve(value.slice(1)))
      : value,
  ) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("request must be a JSON object");
  return parsed as Record<string, unknown>;
}

async function readInput(
  value: string | undefined,
  readText?: (path: string) => Promise<string>,
): Promise<string> {
  if (!value) throw new Error("batch requires --input @file.jsonl");
  if (value === "-") return new Response(Bun.stdin.stream()).text();
  return value.startsWith("@")
    ? (readText ?? ((path) => readFile(path, "utf8")))(resolve(value.slice(1)))
    : value;
}

function writeJson(value: unknown, code: number): number {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  return code;
}
