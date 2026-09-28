import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createRegistry, toolRoutes, type JobsLike } from "../src";
import { join } from "node:path";
import { contextFactory, mockServices, tempProject } from "./mock-services";

function fakeJobs(): JobsLike & {
  runs: Array<{ id: string; kind: string; result: Promise<unknown> }>;
} {
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
    const app = new Hono().route(
      "/",
      toolRoutes({ registry, ctxFactory: contextFactory(services, null), jobs }),
    );

    const manifest = await app.request("/tools/manifest");
    expect(manifest.status).toBe(200);
    const entries = (await manifest.json()) as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;
    expect(entries.length).toBe(registry.list().length);
    expect(entries[0]!.inputSchema["type"]).toBe("object");

    const status = await app.request("/tools/project_status", {
      method: "POST",
      body: JSON.stringify({ project: project.id }),
      headers: { "content-type": "application/json" },
    });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { text: string }).text).toContain('Project "http"');

    const noProject = await app.request("/tools/project_status", { method: "POST", body: "{}" });
    expect(noProject.status).toBe(412);

    const invalid = await app.request("/tools/circuit_query", {
      method: "POST",
      body: JSON.stringify({ project: project.id, select: "zzz" }),
    });
    expect(invalid.status).toBe(400);

    const unknown = await app.request("/tools/nope", { method: "POST", body: "{}" });
    expect(unknown.status).toBe(404);

    const queued = await app.request("/tools/circuit_build", {
      method: "POST",
      body: JSON.stringify({ project: project.id }),
    });
    expect(queued.status).toBe(202);
    expect(((await queued.json()) as { jobId: string }).jobId).toBe("job_1");
    expect(jobs.runs[0]!.kind).toBe("tool:circuit_build");
    await jobs.runs[0]!.result;

    const sync = await app.request("/tools/circuit_build?sync=1", {
      method: "POST",
      body: JSON.stringify({ args: {}, project: project.id }),
    });
    expect(sync.status).toBe(200);
  });

  // H9-S changed what a dirty board looks like over HTTP: verify_drc is a completed measurement,
  // so it answers 200 / ok:true, and the release verdict is verify_gate's 422. Independent
  // evaluation confirmed no in-tree caller reads DRC's status as "the board is clean"; this locks
  // which of the two tools carries the verdict.
  test("a dirty board is a 200 measurement from verify_drc and a 422 verdict from verify_gate", async () => {
    const registry = createRegistry();
    const project = await tempProject("http-dirty-board");
    await Bun.write(join(project.dir, "board.kicad_pcb"), "(kicad_pcb (version 20260831))\n");
    await Bun.write(join(project.dir, "board.kicad_sch"), "(kicad_sch (version 20260831))\n");
    const base = mockServices([project]);
    const services = mockServices([project], {
      kicad: {
        ...base.kicad,
        runDrc: async () => ({
          violations: [],
          unconnected: [],
          schematicParity: [],
          counts: { errors: 3, warnings: 0, unconnected: 12 },
        }),
      },
    });
    const jobs = fakeJobs();
    const app = new Hono().route(
      "/",
      toolRoutes({ registry, ctxFactory: contextFactory(services, null), jobs }),
    );

    const drc = await app.request("/tools/verify_drc?sync=1", {
      method: "POST",
      body: JSON.stringify({ args: { schematicParity: false }, project: project.id }),
      headers: { "content-type": "application/json" },
    });
    expect(drc.status).toBe(200);
    const drcBody = (await drc.json()) as {
      ok: boolean;
      json: { outcome: string; counts: unknown };
    };
    expect(drcBody.ok).toBe(true);
    expect(drcBody.json.outcome).toBe("violations");
    expect(drcBody.json.counts).toEqual({ errors: 3, warnings: 0, unconnected: 12 });

    const gate = await app.request("/tools/verify_gate?sync=1", {
      method: "POST",
      body: JSON.stringify({ args: {}, project: project.id }),
      headers: { "content-type": "application/json" },
    });
    expect(gate.status).toBe(422);
    expect(((await gate.json()) as { ok: boolean }).ok).toBe(false);
  });
});
