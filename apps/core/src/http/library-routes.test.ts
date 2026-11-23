import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { ToolError } from "@fabdesk/tools/library";
import { libraryTestProject } from "../../../../packages/tools/src/library/test-project";
import { libraryRoutes } from "./library-routes";

function appWithLibrary(handle: (id: string) => Promise<unknown>, emit: (event: { topic: string; paths?: string[] }) => void = () => {}) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err), code: "invalid_args" }, 400);
    if (err instanceof ToolError) return c.json({ error: err.message, code: err.code }, err.code === "not_found" ? 404 : 400);
    throw err;
  });
  libraryRoutes(app, {
    projects: { handle } as never,
    bus: { emit } as never,
    store: { projects: { touch() {} } },
  });
  return app;
}

describe("library routes", () => {
  test("lists files already in files/, uploads, searches, and links a component", async () => {
    const project = await libraryTestProject("http-library");
    await mkdir(join(project.dir, "files/datasheets"), { recursive: true });
    await writeFile(join(project.dir, "files/datasheets/existing.md"), "Absolute maximum ratings for the MCU.\n");
    const emitted: Array<{ topic: string; paths?: string[] }> = [];
    const app = appWithLibrary(
      async (id) => (id === project.id ? project : null),
      (event) => emitted.push(event),
    );

    const listed = await app.request(`http://127.0.0.1/projects/${project.id}/library`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { entries: Array<{ path: string }> };
    expect(body.entries.map((entry) => entry.path)).toEqual(["files/datasheets/existing.md"]);

    const form = new FormData();
    form.set("file", new File(["# USB hub notes\nFerrite on 5V.\n"], "usb-notes.md", { type: "text/markdown" }));
    form.set("tags", "power");
    const uploaded = await app.request(`http://127.0.0.1/projects/${project.id}/library`, { method: "POST", body: form });
    expect(uploaded.status).toBe(201);
    const added = (await uploaded.json()) as { entry: { id: string; path: string } };
    expect(added.entry.path).toStartWith("files/");

    const search = await app.request(
      `http://127.0.0.1/projects/${project.id}/library/search?q=${encodeURIComponent("absolute maximum")}`,
    );
    expect(search.status).toBe(200);
    const hits = (await search.json()) as { hits: Array<{ path: string; snippet: string }> };
    expect(hits.hits[0]?.path).toBe("files/datasheets/existing.md");

    const patched = await app.request(`http://127.0.0.1/projects/${project.id}/library/${added.entry.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkedRefs: ["U1"] }),
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { entry: { linkedRefs: string[] } }).entry.linkedRefs).toEqual(["U1"]);
    expect(emitted.some((event) => event.topic === "project.changed")).toBe(true);
  });
});
