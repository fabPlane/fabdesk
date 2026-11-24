/** Photo → project HTTP: sighting, analyze, continue. */
import type { Hono } from "hono";
import { PhotoAnalyzeRequest, PhotoContinueRequest, PhotoSighting } from "@fabdesk/protocol";
import {
  PROJECT_FILES,
  readJsonIfPresent,
  writeJson,
  type ContextFactory,
  type ToolRegistry,
} from "@fabdesk/tools";
import { join } from "node:path";
import type { ProjectStore } from "../projects";

export function photoRoutes<E extends { Variables?: object }>(
  app: Hono<E>,
  deps: {
    projects: ProjectStore;
    store: { projects: { touch(id: string): void } };
    registry: ToolRegistry;
    ctxFactory: ContextFactory;
  },
): void {
  app.get("/projects/:id/photo", async (c) => {
    const id = c.req.param("id");
    const handle = await deps.projects.handle(id);
    if (!handle) return c.json({ error: "not found" }, 404);
    const [session, sighting, intent, draft] = await Promise.all([
      readJsonIfPresent(join(handle.dir, PROJECT_FILES.photoSession)),
      readJsonIfPresent(join(handle.dir, PROJECT_FILES.photoSighting)),
      readJsonIfPresent(join(handle.dir, PROJECT_FILES.photoIntent)),
      readJsonIfPresent(join(handle.dir, PROJECT_FILES.photoDraft)),
    ]);
    return c.json({ session, sighting, intent, draft });
  });

  app.post("/projects/:id/photo/analyze", async (c) => {
    const id = c.req.param("id");
    if (!(await deps.projects.handle(id))) return c.json({ error: "not found" }, 404);
    const body = PhotoAnalyzeRequest.parse(await c.req.json().catch(() => ({})));
    const def = deps.registry.get("photo_analyze");
    if (!def) return c.json({ error: "photo_analyze is not registered" }, 503);
    const out = await deps.registry.invoke("photo_analyze", { ...body, project: id }, (ref) =>
      deps.ctxFactory({
        def,
        projectRef: ref ?? id,
        signal: c.req.raw.signal,
        progress: () => {},
      }),
    );
    return c.json(out.json ?? out);
  });

  app.post("/projects/:id/photo/continue", async (c) => {
    const id = c.req.param("id");
    if (!(await deps.projects.handle(id))) return c.json({ error: "not found" }, 404);
    const body = PhotoContinueRequest.parse((await c.req.json().catch(() => ({}))) ?? {});
    const def = deps.registry.get("photo_to_project");
    if (!def) return c.json({ error: "photo_to_project is not registered" }, 503);
    const out = await deps.registry.invoke("photo_to_project", { ...body, project: id }, (ref) =>
      deps.ctxFactory({
        def,
        projectRef: ref ?? id,
        signal: c.req.raw.signal,
        progress: () => {},
      }),
    );
    return c.json(out.json ?? out);
  });

  app.put("/projects/:id/photo/sighting", async (c) => {
    const id = c.req.param("id");
    const handle = await deps.projects.handle(id);
    if (!handle) return c.json({ error: "not found" }, 404);
    const sighting = PhotoSighting.parse(await c.req.json());
    await writeJson(join(handle.dir, PROJECT_FILES.photoSighting), sighting);
    deps.store.projects.touch(id);
    return c.json({ sighting });
  });
}
