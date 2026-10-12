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

  test("parallel creates and answers are all kept in comments.json", async () => {
    const project = await tempProject("http-comments-parallel");
    const app = appWithComments(async (id) => (id === project.id ? project : null));
    const url = `http://127.0.0.1/projects/${project.id}/comments`;
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        app.request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: `Q${i}?`, anchor: { view: "pcb", ref: `R${i}` } }),
        }),
      ),
    );
    expect(created.map((r) => r.status)).toEqual(Array(8).fill(201));
    const ids = await Promise.all(created.map(async (r) => ((await r.json()) as { comment: { id: string } }).comment.id));
    const answered = await Promise.all(
      ids.map((id, i) =>
        app.request(`${url}/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ answer: `A${i}` }),
        }),
      ),
    );
    expect(answered.map((r) => r.status)).toEqual(Array(8).fill(200));
    const saved = JSON.parse(await readFile(join(project.dir, "comments.json"), "utf8")) as {
      comments: Array<{ id: string; question: string; answer?: string; status: string }>;
    };
    expect(saved.comments.map((c) => c.id).sort()).toEqual([...ids].sort());
    expect(saved.comments.every((c) => c.status === "answered" && c.answer === `A${c.question.slice(1, -1)}`)).toBe(true);
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
