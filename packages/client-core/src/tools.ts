import { BoardSourceSelection, type Job, type ToolManifestEntry } from "@fabdesk/protocol";
import { useCallback, useState } from "react";
import { useCore } from "./provider";
import { openStencilFolder } from "./stencil-folder";
import { useToolManifest } from "./queries";
import { useRunsStore } from "./stores/runs";

/** Preferred tool names with regex fallbacks, since the tool registry is built by another package. */
export const TOOL_PATTERNS = {
  build: { preferred: "circuit_build", patterns: [/^circuit_build$/, /build/] },
  route: { preferred: "route_run", patterns: [/^route_run$/, /^route/, /route/] },
  drc: { preferred: "verify_drc", patterns: [/^verify_drc$/, /^kicad_drc$/, /drc/] },
  erc: { preferred: "verify_erc", patterns: [/^verify_erc$/, /^kicad_erc$/, /erc/] },
  render: {
    preferred: "render_board",
    patterns: [/^render_board$/, /^kicad_render$/, /render(?!_glb)/],
  },
  glb: { preferred: "render_glb", patterns: [/^render_glb$/, /glb/, /3d/] },
  video: { preferred: "render_product_video", patterns: [/^render_product_video$/, /product_video/] },
  stencil: { preferred: "export_stencil", patterns: [/^export_stencil$/, /stencil/] },
} as const;
export type ToolKind = keyof typeof TOOL_PATTERNS;

export function resolveToolName(manifest: ToolManifestEntry[] | undefined, kind: ToolKind): string {
  const spec = TOOL_PATTERNS[kind];
  if (!manifest || manifest.length === 0) return spec.preferred;
  for (const re of spec.patterns) {
    const hit = manifest.find((t) => re.test(t.name));
    if (hit) return hit.name;
  }
  return spec.preferred;
}

export interface ToolRunState {
  status: "idle" | "running" | "done" | "failed";
  jobId?: string;
  result?: unknown;
  error?: string;
  note?: string;
}

/** Synchronous HTTP tools return {ok,text,json}; queued tools and some hosts wrap {result}. */
export function immediateToolResult(response: unknown): unknown {
  return response && typeof response === "object" && Object.hasOwn(response, "result") ? (response as { result: unknown }).result : response;
}

/** Calls a tool; if the daemon answers with a job, waits for it (progress arrives via the runs store). */
export function useRunTool() {
  const { client, host } = useCore();
  const manifest = useToolManifest();
  const [state, setState] = useState<ToolRunState>({ status: "idle" });
  const run = useCallback(
    async (kind: ToolKind | string, args: Record<string, unknown>): Promise<ToolRunState> => {
      const name = kind in TOOL_PATTERNS ? resolveToolName(manifest.data, kind as ToolKind) : kind;
      const finish = async (next: ToolRunState) => {
        const completed =
          kind === "stencil" || name === "export_stencil" || name === "export_laser_stencil"
            ? await openStencilFolder(next, host, client.baseUrl)
            : next;
        setState(completed);
        return completed;
      };
      setState({ status: "running" });
      try {
        const res = await client.callTool(name, args);
        if (res.jobId) {
          setState({ status: "running", jobId: res.jobId });
          useRunsStore
            .getState()
            .upsertJob({ jobId: res.jobId, kind: name, status: "running", startedAt: Date.now(), endpoint: client.baseUrl,
              ...(typeof args.projectId === "string" ? { projectId: args.projectId } : {}),
              ...(BoardSourceSelection.safeParse(args.board).success ? { board: BoardSourceSelection.parse(args.board) } : {}) });
          const job: Job = await client.waitJob(res.jobId);
          const next: ToolRunState =
            job.status === "done"
              ? { status: "done", jobId: res.jobId, result: job.result }
              : { status: "failed", jobId: res.jobId, error: job.error ?? job.status };
          return await finish(next);
        }
        const next: ToolRunState = { status: "done", result: immediateToolResult(res) };
        return await finish(next);
      } catch (e) {
        const next: ToolRunState = {
          status: "failed",
          error: e instanceof Error ? e.message : String(e),
        };
        setState(next);
        return next;
      }
    },
    [client, host, manifest.data],
  );
  return { run, state, manifest: manifest.data };
}
