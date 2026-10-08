import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { commentRoutes } from "./comment-routes";
import { tempProject } from "../../../../packages/tools/test/mock-services";

function appWithComments(
  handle: (id: string) => Promise<unknown>,
  emit: (event: { topic: string; paths?: string[] }) => void = () => {},
) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err), code: "invalid_args" }, 400);
    throw err;
  });
  commentRoutes(app, {
    projects: { handle } as never,
    bus: { emit } as never,
    store: { projects: { touch() {} } },
  });
  return app;
}

describe("comment routes", () => {
  test("pins, answers, and writes NOTES.md as project files", async () => {
    const project = await tempProject("http-comments");
    const emitted: Array<{ topic: string; paths?: string[] }> = [];
    const app = appWithComments(
      async (id) => (id === project.id ? project : null),
      (event) => emitted.push(event),
    );

    const empty = await app.request(`http://127.0.0.1/projects/${project.id}/comments`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      contract: { name: "fabplane.board-comments", version: "1.0.0" },
      comments: [],
    });

    const created = await app.request(`http://127.0.0.1/projects/${project.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "What does this chip do here?",
        anchor: { view: "pcb", x: 12, y: 8, ref: "U12" },
        author: "maya",
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { comment: { id: string; status: string }; label: string };
    expect(body.label).toBe("U12");
    expect(body.comment.status).toBe("open");

    const answered = await app.request(
      `http://127.0.0.1/projects/${project.id}/comments/${body.comment.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answer: "U12 is the MCU." }),
      },
    );
    expect(answered.status).toBe(200);
    expect(((await answered.json()) as { comment: { status: string } }).comment.status).toBe(
      "answered",
    );

    expect(
      (
        await app.request(`http://127.0.0.1/projects/${project.id}/notes`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: "Shared notes.\n" }),
        })
      ).status,
    ).toBe(200);
    expect(
      ((await (await app.request(`http://127.0.0.1/projects/${project.id}/notes`)).json()) as { content: string })
        .content,
    ).toBe("Shared notes.\n");

    expect(JSON.parse(await readFile(join(project.dir, "comments.json"), "utf8"))).toMatchObject({
      contract: { name: "fabplane.board-comments", version: "1.0.0" },
    });
    expect(await readFile(join(project.dir, "NOTES.md"), "utf8")).toBe("Shared notes.\n");
    expect(emitted.map((event) => event.topic)).toEqual(["project.changed", "project.changed", "project.changed"]);
    expect(emitted.flatMap((event) => event.paths ?? [])).toEqual(["comments.json", "comments.json", "NOTES.md"]);
  });

  test("rejects a pin with no locator", async () => {
    const project = await tempProject("http-comments-bad");
    const app = appWithComments(async () => project);
    const res = await app.request(`http://127.0.0.1/projects/${project.id}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question: "What is this?", anchor: { view: "pcb" } }),
    });
    expect(res.status).toBe(400);
  });
});
