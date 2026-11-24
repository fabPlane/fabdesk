import { tmpdir } from "node:os";
import { ReasoningEffort } from "@fabdesk/protocol";

interface ModelCatalog { models: string[]; modelAliases: Record<string, string>; defaultModel?: string; modelEfforts?: Record<string, ReasoningEffort[]> }

/** Read only the model catalog; ignore commands, account information and other initialization data. */
export function parseClaudeModelCatalog(value: unknown): ModelCatalog | undefined {
  const response = value as { type?: string; response?: { subtype?: string; request_id?: string; response?: { models?: unknown } } } | null;
  if (response?.type !== "control_response" || response.response?.subtype !== "success" || response.response.request_id !== "fabdesk-model-catalog") return;
  const rows = response.response.response?.models;
  if (!Array.isArray(rows)) return;
  const models: string[] = [];
  const modelAliases: Record<string, string> = Object.create(null);
  const modelEfforts: Record<string, ReasoningEffort[]> = Object.create(null);
  let defaultModel: string | undefined;
  for (const row of rows) {
    if (!row || typeof row.value !== "string" || typeof row.resolvedModel !== "string" || !row.value || !row.resolvedModel) continue;
    const levels = row.supportsEffort === true && Array.isArray(row.supportedEffortLevels)
      ? row.supportedEffortLevels.flatMap((level: unknown) => { const parsed = ReasoningEffort.safeParse(level); return parsed.success ? [parsed.data] : []; }) : [];
    if (levels.length) {
      modelEfforts[row.value] = levels;
      modelEfforts[row.resolvedModel] = levels;
    }
    if (row.value === "default") { defaultModel = row.resolvedModel; continue; }
    if (!models.includes(row.value)) models.push(row.value);
    modelAliases[row.value] = row.resolvedModel;
    const family = /^claude-(opus|sonnet|haiku|fable)-/.exec(row.resolvedModel)?.[1];
    if (family && !modelAliases[family]) {
      modelAliases[family] = row.resolvedModel;
      if (levels.length) modelEfforts[family] = levels;
    }
  }
  return models.length ? { models, modelAliases, ...(defaultModel ? { defaultModel } : {}), ...(Object.keys(modelEfforts).length ? { modelEfforts } : {}) } : undefined;
}

const cache = new Map<string, { expires: number; value: Promise<ModelCatalog | undefined> }>();

/** Initialize the CLI control protocol without sending a user message or starting a model run. */
export function readClaudeModelCatalog(binary: string, version = ""): Promise<ModelCatalog | undefined> {
  const key = `${binary}\0${version}`;
  const previous = cache.get(key);
  if (previous && previous.expires > Date.now()) return previous.value;
  const value = probe(binary);
  cache.set(key, { expires: Date.now() + 10 * 60_000, value });
  return value;
}

async function probe(binary: string): Promise<ModelCatalog | undefined> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const child = Bun.spawn([binary, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}', "--no-session-persistence"], {
      windowsHide: true,
      cwd: tmpdir(), stdin: "pipe", stdout: "pipe", stderr: "ignore", timeout: 5_000, killSignal: "SIGKILL",
    });
    proc = child;
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: "fabdesk-model-catalog", request: { subtype: "initialize" } }) + "\n");
    child.stdin.flush();
    let pending = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    try { while (true) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      bytes += chunk.length;
      if (bytes > 1_048_576) break;
      pending += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try { const catalog = parseClaudeModelCatalog(JSON.parse(line)); if (catalog) return catalog; } catch { /* CLI diagnostic, not JSON. */ }
      }
    } } finally { reader.releaseLock(); }
  } catch { /* Older or unavailable CLIs retain the adapter's alias list. */ }
  finally { if (proc) { proc.kill(); await proc.exited.catch(() => undefined); } }
  return undefined;
}
