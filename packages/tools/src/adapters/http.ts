/**
 * HTTP adapter: `GET /tools/manifest` (WebMCP manifest) and `POST /tools/:name`.
 * Long-running tools are enqueued as jobs and answer `202 {jobId}` unless `?sync=1`.
 */
import { Hono } from "hono";
import type { ToolManifestEntry } from "@fabdesk/protocol";
import { ToolError, type ContextFactory, type ToolDef, type ToolOutput, type ToolRegistry } from "../registry";

export type JobClass = "router" | "build" | "kicad" | "render" | "default";

export interface JobsLike {
  enqueue(opts: {
    kind: string;
    jobClass: JobClass;
    projectId: string | null;
    run(job: { signal: AbortSignal; progress(p: number, note?: string): void }): Promise<unknown>;
  }): { id: string };
}

export function jobClassFor(def: ToolDef): JobClass {
  if (def.name === "route_run") return "router";
  if (def.name === "circuit_build") return "build";
  if (def.name === "render_board") return "render";
  if (["kicad", "verify", "export", "render"].includes(def.toolset) || def.name === "verify_drc") return "kicad";
  return "default";
}

export function toolManifest(
  registry: ToolRegistry,
  allow: (def: ToolDef) => boolean = () => true,
): ToolManifestEntry[] {
  const allowed = new Set(registry.list().filter(allow).map((d) => d.name));
  return registry.manifest().filter((entry) => allowed.has(entry.name));
}

export type HttpAdapterOptions = {
  registry: ToolRegistry;
  ctxFactory: ContextFactory;
  jobs: JobsLike;
  /**
   * Whether this caller may see and call `def`. Refused tools answer 403 `tool_local_only` and
   * are left out of `/tools/manifest`. Every tool is allowed when omitted.
   */
  allowTool?: (def: ToolDef, token: string | undefined) => boolean;
};

export type HttpEnv = { Variables: { token?: string; principalSubject?: string } };

export function toolRoutes(opts: HttpAdapterOptions): Hono<HttpEnv> {
  const { registry, ctxFactory, jobs } = opts;
  const allowTool = opts.allowTool ?? (() => true);
  const app = new Hono<HttpEnv>();

  app.get("/tools/manifest", (c) => {
    const token = c.get("token");
    return c.json(toolManifest(registry, (def) => allowTool(def, token)));
  });

  app.post("/tools/:name", async (c) => {
    const name = c.req.param("name");
    const def = registry.get(name);
    if (!def) return c.json({ error: `unknown tool ${name}` }, 404);
    if (!allowTool(def, c.get("token"))) return c.json({ error: "tool_local_only" }, 403);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const args = (body["args"] && typeof body["args"] === "object" ? { ...(body["args"] as Record<string, unknown>), ...(body["project"] ? { project: body["project"] } : {}) } : body) as Record<string, unknown>;
    const sync = c.req.query("sync") === "1" || body["sync"] === true;
    const token = c.get("token");

    // Validate eagerly so bad arguments fail with 400 even for queued jobs.
    const parsed = registry.inputObject(def).safeParse(args);
    if (!parsed.success) return c.json({ error: `invalid arguments: ${parsed.error.message}` }, 400);
    const projectRef = typeof args["project"] === "string" ? (args["project"] as string) : undefined;

    const run = (signal: AbortSignal, progress: (p: number, note?: string) => void) =>
      registry.invoke(name, args, (ref) => ctxFactory({ def, projectRef: ref, signal, progress, ...(token ? { token } : {}) }));

    if (def.longRunning && !sync) {
      // Resolve the project id up front so the job is attributed correctly.
      let projectId: string | null = null;
      try {
        const ctx = await ctxFactory({ def, projectRef, signal: new AbortController().signal, progress: () => {}, ...(token ? { token } : {}) });
        projectId = ctx.project?.id ?? null;
        if ((def.scope ?? "project") === "project" && !projectId) return c.json({ error: "no project selected: pass `project`" }, 412);
      } catch (e) {
        return errorResponse(c, e);
      }
      const job = jobs.enqueue({ kind: `tool:${name}`, jobClass: jobClassFor(def), projectId, run: (j) => run(j.signal, j.progress) });
      return c.json({ jobId: job.id }, 202);
    }

    try {
      const output = await run(c.req.raw.signal, () => {});
      return c.json(serializeOutput(output), output.isError ? 422 : 200);
    } catch (e) {
      return errorResponse(c, e);
    }
  });

  return app;
}

export function serializeOutput(output: ToolOutput): { ok: boolean; text: string; json?: unknown; images?: ToolOutput["images"] } {
  return {
    ok: !output.isError,
    text: output.text ?? (output.json !== undefined ? JSON.stringify(output.json) : "ok"),
    ...(output.json !== undefined ? { json: output.json } : {}),
    ...(output.images ? { images: output.images } : {}),
  };
}

function errorResponse(c: { json: (body: unknown, status: 400 | 404 | 412 | 499 | 500 | 503) => Response }, e: unknown): Response {
  if (e instanceof ToolError) {
    const status = e.code === "invalid_args" ? 400 : e.code === "not_found" ? 404 : e.code === "precondition" ? 412 : e.code === "unavailable" ? 503 : e.code === "cancelled" ? 499 : 500;
    return c.json({ error: e.message, code: e.code }, status);
  }
  return c.json({ error: e instanceof Error ? e.message : String(e), code: "internal" }, 500);
}
