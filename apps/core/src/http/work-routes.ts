/**
 * The work hub over HTTP: `/work/*` for the GitHub connection, repositories and the overview, and
 * `/projects/:id/github` for a project's own repository.
 *
 * Changing the connection and publishing a project are for the local desktop connection only: a
 * paired phone can read the hub, not replace the token or create repositories.
 */
import type { Context, Hono } from "hono";
import { PublishProject, UpdateWorkConnection, WorkScope } from "@fabdesk/protocol";
import { WorkHubError, type WorkHub } from "../work-hub";
import type { AppDeps } from "./app";

type Deps = Pick<AppDeps, "projects" | "listener"> & { workHub: WorkHub };

export function workRoutes<E extends { Variables?: object }>(app: Hono<E>, deps: Deps) {
  const hub = deps.workHub;
  const run = (fn: (c: Context<E>) => Promise<Response>) => async (c: Context<E>): Promise<Response> => {
    try {
      return await fn(c);
    } catch (error) {
      if (error instanceof WorkHubError) return c.json({ error: error.message, code: error.code }, error.status as 400);
      throw error;
    }
  };
  const localOnly = (c: Context<E>) =>
    deps.listener === "remote" ? c.json({ error: "This needs the local desktop connection", code: "local_only" }, 403) : null;
  const refresh = (c: Context<E>) => c.req.query("refresh") === "1";

  app.get("/work/connection", run(async c => c.json(await hub.connection(refresh(c)))));
  app.put("/work/connection", run(async c => localOnly(c) ?? c.json(await hub.update(UpdateWorkConnection.parse(await c.req.json())))));
  app.delete("/work/connection", run(async c => localOnly(c) ?? c.json(await hub.disconnect())));
  app.get("/work/repos", run(async c => c.json(await hub.repos(refresh(c)))));
  app.get("/work/overview", run(async c => c.json(await hub.overview(WorkScope.parse(c.req.query("scope") ?? "all"), refresh(c)))));

  app.get("/projects/:id/github", run(async c => {
    const project = await deps.projects.handle(c.req.param("id") ?? "");
    if (!project) return c.json({ error: "Project not found" }, 404);
    return c.json(await hub.projectLink(project.dir));
  }));
  app.post("/projects/:id/github", run(async c => {
    const denied = localOnly(c);
    if (denied) return denied;
    const project = await deps.projects.handle(c.req.param("id") ?? "");
    if (!project) return c.json({ error: "Project not found" }, 404);
    const input = PublishProject.parse(await c.req.json());
    return c.json(await hub.publish(project.dir, input), 201);
  }));
}
