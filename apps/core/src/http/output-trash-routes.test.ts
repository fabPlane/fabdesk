import { test, expect } from "bun:test";
import { Hono } from "hono";
import { z } from "zod/v4";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tempProject } from "../../../../packages/tools/test/mock-services";
import { outputTrashRoutes } from "./output-trash-routes";

test("output trash HTTP validates paths, rechecks active work, reports partial results and emits only actual changes", async () => {
  const project = await tempProject("http-output-trash"), changed: string[][] = [];
  let active = false;
  const app = new Hono(); app.onError((error, c) => error instanceof z.ZodError ? c.json({ error: "Invalid arguments" }, 400) : c.json({ error: error.message }, 500));
  outputTrashRoutes(app, {
    projects: { handle: async (id: string) => id === project.id ? project : null } as never,
    jobs: { list: () => active ? [{ projectId: project.id, status: "running" }] : [] } as never,
    runs: null, store: { projects: { touch() {} } } as never,
    bus: { emit: (event: { paths?: string[] }) => changed.push(event.paths ?? []) } as never,
  });
  const base = `/projects/${project.id}/output-trash`;
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await mkdir(join(project.dir, "renders")); await writeFile(join(project.dir, "renders/top.png"), "pixels");
    expect((await post(base + "/review", { paths: ["../outside.png"] })).status).toBe(400);
    expect((await post(base + "/restore", { ids: ["../../outside"] })).status).toBe(400);
    expect((await app.request("/projects/missing/output-trash")).status).toBe(404);
    const review = await (await post(base + "/review", { paths: ["renders/top.png", "fabdesk.json"] })).json() as { files: Array<{ path: string; eligible: boolean; token?: string }> };
    expect(review.files.map(row => row.eligible)).toEqual([true, false]);
    const files = review.files.filter(row => row.eligible).map(row => ({ path: row.path, token: row.token! }));
    active = true;
    const blocked = await (await post(base, { files })).json() as { results: Array<{ ok: boolean; reason: string }> };
    expect(blocked.results[0]!.ok).toBe(false); expect(blocked.results[0]!.reason).toContain("active project task"); expect(changed).toEqual([]);
    active = false;
    const moved = await (await post(base, { files })).json() as { results: Array<{ ok: boolean; id: string }> };
    expect(moved.results[0]!.ok).toBe(true); expect(changed).toEqual([["renders/top.png"]]);
    expect((await (await app.request(base)).json() as { files: unknown[] }).files).toHaveLength(1);
    const restored = await (await post(base + "/restore", { ids: [moved.results[0]!.id] })).json() as { results: Array<{ ok: boolean }> };
    expect(restored.results[0]!.ok).toBe(true); expect(changed).toEqual([["renders/top.png"], ["renders/top.png"]]);
    expect(await readFile(join(project.dir, "renders/top.png"), "utf8")).toBe("pixels");
  } finally { await rm(dirname(project.dir), { recursive: true, force: true }); }
});
