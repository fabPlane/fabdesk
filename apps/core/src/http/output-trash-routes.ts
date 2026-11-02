import type { Hono } from "hono";
import { MoveOutputsToTrash, RestoreOutputTrash, ReviewOutputTrash } from "@fabdesk/protocol";
import { OutputTrash } from "../output-trash";
import type { AppDeps } from "./app";

export function outputTrashRoutes<E extends { Variables?: object }>(app: Hono<E>, deps: Pick<AppDeps, "projects" | "jobs" | "runs" | "store" | "bus">) {
  const trash = new OutputTrash(id => {
    if (deps.jobs.list().some(job => job.projectId === id && (job.status === "queued" || job.status === "running"))) return "An active project task may be using this output. Wait or cancel it in Project activity.";
    if (deps.runs?.projectBusyMessage(id)) return "An agent is working in this project. Wait for it to finish before moving or restoring outputs.";
    return null;
  });
  const changed = (projectId: string, paths: string[]) => {
    deps.store.projects.touch(projectId);
    deps.bus.emit({ ts: Date.now(), topic: "project.changed", projectId, paths });
  };
  app.post("/projects/:id/output-trash/review", async c => {
    const project = await deps.projects.handle(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const input = ReviewOutputTrash.parse(await c.req.json());
    return c.json(await trash.review(project, input.paths));
  });
  app.post("/projects/:id/output-trash", async c => {
    const project = await deps.projects.handle(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const input = MoveOutputsToTrash.parse(await c.req.json());
    const results = await trash.move(project, input.files);
    if (results.some(row => row.ok)) changed(project.id, results.filter(row => row.ok).map(row => row.path));
    return c.json({ results });
  });
  app.get("/projects/:id/output-trash", async c => {
    const project = await deps.projects.handle(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json({ files: await trash.list(project) });
  });
  app.post("/projects/:id/output-trash/restore", async c => {
    const project = await deps.projects.handle(c.req.param("id"));
    if (!project) return c.json({ error: "Project not found" }, 404);
    const input = RestoreOutputTrash.parse(await c.req.json());
    const results = await trash.restore(project, input.ids);
    if (results.some(row => row.ok)) changed(project.id, results.filter(row => row.ok).map(row => row.path));
    return c.json({ results });
  });
}
