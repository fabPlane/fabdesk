/** CRUD for git-native `comments.json` and `NOTES.md`. */
import type { Hono } from "hono";
import { relative } from "node:path";
import {
  CreateBoardComment,
  PatchBoardComment,
  WriteBoardNotes,
  commentAnchorLabel,
  BoardSourceSelection,
} from "@fabdesk/protocol";
import {
  createComment,
  loadComments,
  loadNotes,
  patchComment,
  saveNotes,
  updateComments,
  type ProjectHandle,
} from "@fabdesk/tools";
import { resolveNativeBoardBinding } from "../assembly-board-binding";
import type { EventBus } from "../bus";
import type { ProjectStore } from "../projects";

export function commentRoutes<E extends { Variables?: object }>(
  app: Hono<E>,
  deps: { projects: ProjectStore; bus: EventBus; store: { projects: { touch(id: string): void } } },
): void {
  const scope = async (project: ProjectHandle, sourceId?: string, manifestSha256?: string) => {
    if (sourceId === undefined && manifestSha256 === undefined) return { project, path: "comments.json", check: async () => {} };
    const selector = BoardSourceSelection.parse({ sourceId, manifestSha256 });
    const binding = await resolveNativeBoardBinding(project, selector);
    const leaf = { ...project, dir: binding.boardDir };
    const prefix = relative(binding.rootDir, binding.boardDir).replaceAll("\\", "/");
    return { project: leaf, path: prefix ? `${prefix}/comments.json` : "comments.json", check: () => binding.assertCurrent(binding.boardDir) };
  };
  const changed = (projectId: string, paths: string[]) => {
    deps.store.projects.touch(projectId);
    deps.bus.emit({ ts: Date.now(), topic: "project.changed", projectId, paths });
  };

  app.get("/projects/:id/comments", async (c) => {
    const h = await deps.projects.handle(c.req.param("id"));
    if (!h) return c.json({ error: "not found" }, 404);
    const scoped = await scope(h, c.req.query("sourceId"), c.req.query("manifestSha256"));
    const file = await loadComments(scoped.project);
    await scoped.check();
    return c.json(file);
  });

  app.post("/projects/:id/comments", async (c) => {
    const id = c.req.param("id");
    const h = await deps.projects.handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    const body = CreateBoardComment.parse(await c.req.json());
    const scoped = await scope(h, c.req.query("sourceId"), c.req.query("manifestSha256"));
    const comment = await updateComments(scoped.project, (loaded) => {
      const { file, comment } = createComment(loaded, body);
      return { file, result: comment };
    }, scoped.check);
    changed(id, [scoped.path]);
    return c.json({ comment, label: commentAnchorLabel(comment.anchor) }, 201);
  });

  app.patch("/projects/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const h = await deps.projects.handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    const body = PatchBoardComment.parse(await c.req.json());
    const scoped = await scope(h, c.req.query("sourceId"), c.req.query("manifestSha256"));
    const commentId = c.req.param("commentId");
    const comment = await updateComments(scoped.project, (loaded) => {
      const { file, comment } = patchComment(loaded, commentId, body);
      return { file, result: comment };
    }, scoped.check);
    changed(id, [scoped.path]);
    return c.json({ comment, label: commentAnchorLabel(comment.anchor) });
  });

  app.get("/projects/:id/notes", async (c) => {
    const h = await deps.projects.handle(c.req.param("id"));
    if (!h) return c.json({ error: "not found" }, 404);
    const content = await loadNotes(h);
    return c.json({ path: "NOTES.md", content, chars: content.length });
  });

  app.put("/projects/:id/notes", async (c) => {
    const id = c.req.param("id");
    const h = await deps.projects.handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    const body = WriteBoardNotes.parse(await c.req.json());
    await saveNotes(h, body.content);
    changed(id, ["NOTES.md"]);
    return c.json({ ok: true, path: "NOTES.md", chars: body.content.length });
  });
}
