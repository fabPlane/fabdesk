import { tmpdir } from "node:os";

interface ModelCatalog { models: string[]; defaultModel?: string }

/** Read only selectable model IDs. Account fields and server instructions are not metadata. */
export function parseCodexModelCatalog(value: unknown): ModelCatalog | undefined {
  if (!value || typeof value !== "object" || !("data" in value) || !Array.isArray(value.data)) return;
  const models: string[] = [];
  let defaultModel: string | undefined;
  for (const row of value.data) {
    if (!row || row.hidden === true || typeof row.model !== "string" || !row.model.trim() || row.model.length > 200) continue;
    const model = row.model.trim();
    if (!models.includes(model)) models.push(model);
    if (row.isDefault === true) defaultModel = model;
  }
  return models.length ? { models, ...(defaultModel ? { defaultModel } : {}) } : undefined;
}

const cache = new Map<string, { expires: number; value: Promise<ModelCatalog | undefined> }>();

/** Initialize the installed CLI without creating a thread, sending a prompt or changing config. */
export function readCodexModelCatalog(binary: string, version = ""): Promise<ModelCatalog | undefined> {
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
    const env = { ...process.env };
    for (const name of ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY"]) delete env[name];
    const child = Bun.spawn([binary, "app-server", "--stdio", "-c", "features.apps=false", "-c", "features.plugins=false", "-c", "features.remote_plugin=false"], {
      cwd: tmpdir(), env, stdin: "pipe", stdout: "pipe", stderr: "ignore", timeout: 5_000, killSignal: "SIGKILL",
    });
    proc = child;
    const send = (message: unknown) => { child.stdin.write(JSON.stringify(message) + "\n"); child.stdin.flush(); };
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "fabplane-model-catalog", version: "0.2.0" }, capabilities: {} } });
    let pending = "";
    let bytes = 0;
    let initialized = false;
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
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        let message: { id?: number; result?: unknown; error?: unknown };
        try { message = JSON.parse(line); } catch { continue; }
        if (message?.id === 1 && !initialized) {
          if (message.error || !message.result) return;
          initialized = true;
          send({ method: "initialized", params: {} });
          send({ id: 2, method: "model/list", params: { limit: 100 } });
        } else if (message?.id === 2 && initialized) {
          return message.error ? undefined : parseCodexModelCatalog(message.result);
        }
      }
    } } finally { reader.releaseLock(); }
  } catch { /* Older or unavailable CLIs retain the adapter's fallback list. */ }
  finally { if (proc) { proc.kill(); await proc.exited.catch(() => undefined); } }
  return undefined;
}
