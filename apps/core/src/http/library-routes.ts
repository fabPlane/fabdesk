/** CRUD for git-native `files/` library (datasheets, docs, images). */
import type { Hono } from "hono";
import { LibraryEntryPatch } from "@fabdesk/protocol";
import {
  addLibraryFile,
  listLibrary,
  patchLibraryEntry,
  removeLibraryEntry,
  searchLibrary,
  type ProjectHandle,
} from "@fabdesk/tools/library";
import type { EventBus } from "../bus";
import type { ProjectStore } from "../projects";

const MAX_UPLOAD = 25 * 1024 * 1024;

function changed(
  deps: { store: { projects: { touch(id: string): void } }; bus: EventBus },
  projectId: string,
  paths: string[],
) {
  deps.store.projects.touch(projectId);
  deps.bus.emit({ ts: Date.now(), topic: "project.changed", projectId, paths });
}

export function libraryRoutes<E extends { Variables?: object }>(
  app: Hono<E>,
  deps: { projects: ProjectStore; bus: EventBus; store: { projects: { touch(id: string): void } } },
): void {
  const handle = async (id: string): Promise<ProjectHandle | null> => deps.projects.handle(id);

  app.get("/projects/:id/library", async (c) => {
    const h = await handle(c.req.param("id"));
    if (!h) return c.json({ error: "not found" }, 404);
    return c.json({ entries: await listLibrary(h) });
  });

  app.get("/projects/:id/library/search", async (c) => {
    const h = await handle(c.req.param("id"));
    if (!h) return c.json({ error: "not found" }, 404);
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ hits: [], query: q });
    const ref = c.req.query("ref");
    const hits = await searchLibrary(h, q, { ...(ref ? { ref } : {}) });
    return c.json({ hits, query: q });
  });

  app.post("/projects/:id/library", async (c) => {
    const id = c.req.param("id");
    const h = await handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    if (h.manifest().ideaDraft)
      return c.json({ error: "Create a project before adding library files.", code: "draft_project_required" }, 412);
    const ct = c.req.header("content-type") ?? "";
    if (!ct.startsWith("multipart/form-data")) return c.json({ error: "multipart field `file` required" }, 400);
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "multipart field `file` required" }, 400);
    if (file.size > MAX_UPLOAD) return c.json({ error: "Library files must be 25 MiB or smaller" }, 413);
    const data = new Uint8Array(await file.arrayBuffer());
    const folder = typeof form.get("folder") === "string" ? String(form.get("folder")) : undefined;
    const title = typeof form.get("title") === "string" ? String(form.get("title")) : undefined;
    const tagsRaw = typeof form.get("tags") === "string" ? String(form.get("tags")) : "";
    const refsRaw = typeof form.get("linkedRefs") === "string" ? String(form.get("linkedRefs")) : "";
    const entry = await addLibraryFile(h, {
      filename: file.name || "upload.bin",
      data,
      ...(title ? { title } : {}),
      ...(folder ? { folder } : {}),
      ...(tagsRaw ? { tags: tagsRaw.split(",").map((item) => item.trim()).filter(Boolean) } : {}),
      ...(refsRaw ? { linkedRefs: refsRaw.split(",").map((item) => item.trim()).filter(Boolean) } : {}),
    });
    changed(deps, id, [entry.path, "files/library.json"]);
    return c.json({ entry }, 201);
  });

  app.patch("/projects/:id/library/:entryId", async (c) => {
    const id = c.req.param("id");
    const h = await handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    const patch = LibraryEntryPatch.parse(await c.req.json());
    const entry = await patchLibraryEntry(h, c.req.param("entryId"), patch);
    changed(deps, id, ["files/library.json"]);
    return c.json({ entry });
  });

  app.delete("/projects/:id/library/:entryId", async (c) => {
    const id = c.req.param("id");
    const h = await handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    const entry = await removeLibraryEntry(h, c.req.param("entryId"));
    changed(deps, id, [entry.path, "files/library.json"]);
    return c.json({ ok: true, path: entry.path });
  });
}
