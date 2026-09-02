import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createRegistry, toolRoutes, type JobsLike } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

function fakeJobs(): JobsLike & { runs: Array<{ id: string; kind: string; result: Promise<unknown> }> } {
  const runs: Array<{ id: string; kind: string; result: Promise<unknown> }> = [];
  return {
    runs,
    enqueue({ kind, run }) {
      const id = `job_${runs.length + 1}`;
      const result = run({ signal: new AbortController().signal, progress: () => {} });
      runs.push({ id, kind, result });
      return { id };
    },
  };
}

describe("http adapter", () => {
  test("manifest, sync call, job enqueue, validation", async () => {
    const registry = createRegistry();
    const project = await tempProject("http");
    const services = mockServices([project]);
    const jobs = fakeJobs();
    const app = new Hono().route("/", toolRoutes({ registry, ctxFactory: contextFactory(services, null), jobs }));

    const manifest = await app.request("/tools/manifest");
    expect(manifest.status).toBe(200);
    const entries = (await manifest.json()) as Array<{ name: string; inputSchema: Record<string, unknown> }>;
    expect(entries.length).toBe(registry.list().length);
    expect(entries[0]!.inputSchema["type"]).toBe("object");

    const status = await app.request("/tools/project_status", { method: "POST", body: JSON.stringify({ project: project.id }), headers: { "content-type": "application/json" } });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { text: string }).text).toContain('Project "http"');

    const noProject = await app.request("/tools/project_status", { method: "POST", body: "{}" });
    expect(noProject.status).toBe(412);

    const invalid = await app.request("/tools/circuit_query", { method: "POST", body: JSON.stringify({ project: project.id, select: "zzz" }) });
    expect(invalid.status).toBe(400);

    const unknown = await app.request("/tools/nope", { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);

    const queued = await app.request("/tools/circuit_build", { method: "POST", body: JSON.stringify({ project: project.id }) });
    expect(queued.status).toBe(202);
    expect(((await queued.json()) as { jobId: string }).jobId).toBe("job_1");
    expect(jobs.runs[0]!.kind).toBe("tool:circuit_build");
    await jobs.runs[0]!.result;

    const sync = await app.request("/tools/circuit_build?sync=1", { method: "POST", body: JSON.stringify({ args: {}, project: project.id }) });
    expect(sync.status).toBe(200);
  });
});
