/** CRUD for git-native `comments.json` and `NOTES.md`. */
import type { Hono } from "hono";
import {
  CreateBoardComment,
  PatchBoardComment,
  WriteBoardNotes,
  commentAnchorLabel,
} from "@fabdesk/protocol";
import {
  createComment,
  loadComments,
  loadNotes,
  patchComment,
  saveNotes,
  updateComments,
} from "@fabdesk/tools";
import type { EventBus } from "../bus";
import type { ProjectStore } from "../projects";

export function commentRoutes<E extends { Variables?: object }>(
  app: Hono<E>,
  deps: { projects: ProjectStore; bus: EventBus; store: { projects: { touch(id: string): void } } },
): void {
  const changed = (projectId: string, paths: string[]) => {
    deps.store.projects.touch(projectId);
    deps.bus.emit({ ts: Date.now(), topic: "project.changed", projectId, paths });
  };

  app.get("/projects/:id/comments", async (c) => {
    const h = await deps.projects.handle(c.req.param("id"));
    if (!h) return c.json({ error: "not found" }, 404);
    return c.json(await loadComments(h));
  });

  app.post("/projects/:id/comments", async (c) => {
    const id = c.req.param("id");
    const h = await deps.projects.handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    const body = CreateBoardComment.parse(await c.req.json());
    const comment = await updateComments(h, (loaded) => {
      const { file, comment } = createComment(loaded, body);
      return { file, result: comment };
    });
    changed(id, ["comments.json"]);
    return c.json({ comment, label: commentAnchorLabel(comment.anchor) }, 201);
  });

  app.patch("/projects/:id/comments/:commentId", async (c) => {
    const id = c.req.param("id");
    const h = await deps.projects.handle(id);
    if (!h) return c.json({ error: "not found" }, 404);
    const body = PatchBoardComment.parse(await c.req.json());
    const commentId = c.req.param("commentId");
    const comment = await updateComments(h, (loaded) => {
      const { file, comment } = patchComment(loaded, commentId, body);
      return { file, result: comment };
    });
    changed(id, ["comments.json"]);
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
