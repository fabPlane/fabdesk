import type { HostAdapter } from "./provider";
import type { ToolRunState } from "./tools";

/** Reveal only a completed local export; a remote core's paths belong to that host. */
export async function openStencilFolder(
  state: ToolRunState,
  host: Pick<HostAdapter, "openPath">,
  coreUrl: string,
): Promise<ToolRunState> {
  if (state.status !== "done" || !host.openPath) return state;
  let hostname: string;
  try { hostname = new URL(coreUrl).hostname; } catch { return state; }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return state;
  const result = state.result as { json?: unknown; path?: unknown } | null;
  const summary = (result?.json ?? result) as { path?: unknown } | null;
  const path = summary?.path;
  if (typeof path !== "string" || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) return state;
  const end = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (end < 0) return state;
  const folder = path.slice(0, end) || "/";
  try {
    await host.openPath(folder);
    return state;
  } catch (error) {
    // The stencil is still successfully exported if the file manager cannot open.
    const reason = error instanceof Error ? error.message : String(error);
    return { ...state, note: `Stencil exported, but could not open ${folder}: ${reason}` };
  }
}
