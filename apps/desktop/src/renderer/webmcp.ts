/**
 * WebMCP registration: exposes fabdesk-core tools on `document.modelContext` so browser-side agents
 * (Chromium's WebMCP or the MCP-B extension) can call them. Read-only tools by default; all tools when
 * `settings.webmcpWriteTools` is on. Re-registers whenever the active project or settings change.
 */
import type { ToolManifestEntry } from "@fabdesk/protocol";
import { useUiStore, type CoreClient } from "@fabdesk/ui";
import type { InputSchema, ModelContext } from "@mcp-b/webmcp-types";

export async function getModelContext(): Promise<ModelContext | null> {
  let mc = document.modelContext ?? navigator.modelContext;
  if (!mc) {
    try {
      await import("@mcp-b/global");
    } catch (e) {
      console.warn("[webmcp] polyfill failed to load", e);
    }
    mc = document.modelContext ?? navigator.modelContext;
  }
  return mc ?? null;
}

type RegisterFn = (tool: unknown, options?: { signal?: AbortSignal }) => Promise<void>;

export function selectTools(manifest: ToolManifestEntry[], writeTools: boolean): ToolManifestEntry[] {
  return manifest.filter((t) => writeTools || t.annotations.readOnlyHint === true);
}

async function register(mc: ModelContext, client: CoreClient, signal: AbortSignal): Promise<number> {
  const [manifest, settings] = await Promise.all([client.toolManifest(), client.getSettings()]);
  if (signal.aborted) return 0;
  const tools = selectTools(manifest, settings.webmcpWriteTools);
  const projectId = useUiStore.getState().activeProjectId;
  const registerTool = mc.registerTool as unknown as RegisterFn;
  let count = 0;
  for (const t of tools) {
    const tool = {
      name: t.name,
      title: t.title,
      description: projectId ? `${t.description} (active project: ${projectId})` : t.description,
      inputSchema: (t.inputSchema.type ? t.inputSchema : { type: "object", ...t.inputSchema }) as InputSchema,
      annotations: { readOnlyHint: t.annotations.readOnlyHint === true },
      execute: async (input: Record<string, unknown>) => {
        const args = projectId && !("projectId" in input) ? { projectId, ...input } : input;
        const res = await client.callTool(t.name, args);
        if (res.jobId) {
          const job = await client.waitJob(res.jobId);
          if (job.status !== "done") throw new Error(job.error ?? `job ${job.status}`);
          return job.result;
        }
        return res.result;
      },
    };
    try {
      await registerTool(tool, { signal });
      count += 1;
    } catch (e) {
      console.warn(`[webmcp] could not register ${t.name}`, e);
    }
  }
  return count;
}

/** Starts registration; returns a teardown that unregisters everything. */
export function startWebMcp(client: CoreClient): () => void {
  let controller: AbortController | null = null;
  let disposed = false;
  let mcPromise: Promise<ModelContext | null> | null = null;

  const refresh = () => {
    controller?.abort();
    const c = new AbortController();
    controller = c;
    mcPromise ??= getModelContext();
    void mcPromise.then(async (mc) => {
      if (!mc || disposed || c.signal.aborted) return;
      const n = await register(mc, client, c.signal);
      if (!c.signal.aborted) console.info(`[webmcp] registered ${n} tools`);
    });
  };

  refresh();
  const unsub = useUiStore.subscribe((s, prev) => {
    if (s.activeProjectId !== prev.activeProjectId) refresh();
  });
  const settingsSub = client.subscribe(["project.*"], () => {});
  settingsSub.close();

  return () => {
    disposed = true;
    controller?.abort();
    unsub();
  };
}
