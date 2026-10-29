import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod/v4";
import { commentRoutes } from "./comment-routes";
import { mockServices, tempProject } from "../../../../packages/tools/test/mock-services";
import { createRegistry, inspectProjectBoardSources, ToolError, updateComments, createComment } from "@fabdesk/tools";
import { createContextFactory } from "../context";
import type { ProjectStore } from "../projects";
import { resolveNativeBoardBinding } from "../assembly-board-binding";

function appWithComments(
  handle: (id: string) => Promise<unknown>,
  emit: (event: { topic: string; paths?: string[] }) => void = () => {},
) {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof z.ZodError) return c.json({ error: z.prettifyError(err), code: "invalid_args" }, 400);
    if (err instanceof ToolError) return c.json({ error: err.message }, 412);
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

async function assemblyCommentsFixture() {
  const project = await tempProject("source-comments");
  for (const id of ["a", "b"]) { await mkdir(join(project.dir, "boards", id), { recursive: true }); await writeFile(join(project.dir, "boards", id, "board.kicad_pcb"), `(kicad_pcb ${id})`); }
  const manifest = { contract: "fabplane.assembly.v1", sources: ["a", "b"].map(id => ({ id, name: id, location: "project", directory: `boards/${id}` })), instances: ["a", "a-repeat", "b"].map(id => ({ id, name: id, sourceId: id === "a-repeat" ? "a" : id })), connections: [] };
  await writeFile(join(project.dir, "fabplane.assembly.json"), JSON.stringify(manifest));
  const sources = await inspectProjectBoardSources(project), board = { sourceId: "a", manifestSha256: sources.manifestSha256! };
  return { project, manifest, board };
}

test("member HTTP pins stay with one source, retain legacy root discussion, and reject stale selectors", async () => {
  const { project, board, manifest } = await assemblyCommentsFixture(), changed: string[] = [];
  const app = appWithComments(async () => project, event => changed.push(...event.paths ?? []));
  const base = `/projects/${project.id}/comments`, query = `?sourceId=a&manifestSha256=${board.manifestSha256}`;
  const post = (url: string, question: string) => app.request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question, anchor: { view: "pcb", coordinateSystem: "kicad-pcb-mm", xMm: 1, yMm: 2 } }) });
  expect((await post(base, "Legacy project pin")).status).toBe(201);
  const pinned = await post(base + query, "Source A pin"); expect(pinned.status).toBe(201);
  const id = (await pinned.json() as { comment: { id: string } }).comment.id;
  expect(await (await app.request(base + query)).json()).toMatchObject({ comments: [{ question: "Source A pin" }] });
  expect(await (await app.request(base + query.replace("sourceId=a", "sourceId=b"))).json()).toMatchObject({ comments: [] });
  expect(await (await app.request(base)).json()).toMatchObject({ comments: [{ question: "Legacy project pin" }] });
  expect((await app.request(`${base}/${id}${query}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "Grounded answer", status: "answered" }) })).status).toBe(200);
  expect(changed).toEqual(["comments.json", "boards/a/comments.json", "boards/a/comments.json"]);
  expect((await app.request(base + "?sourceId=a")).status).toBe(400);
  expect((await post(base + query.replace("sourceId=a", "sourceId=a-repeat"), "Wrong instance")).status).toBe(412);
  const before = await readFile(join(project.dir, "boards/a/comments.json"), "utf8");
  await writeFile(join(project.dir, "fabplane.assembly.json"), JSON.stringify({ ...manifest, connections: [] }, null, 2));
  expect((await post(base + query, "Stale pin")).status).toBe(412);
  expect(await readFile(join(project.dir, "boards/a/comments.json"), "utf8")).toBe(before);
  expect(await readFile(join(project.dir, "boards/a/board.kicad_pcb"), "utf8")).toBe("(kicad_pcb a)");
});

test("comment MCP tools bind list/answer/resolve to the same source and recheck ownership before save", async () => {
  const { project, board } = await assemblyCommentsFixture(), services = mockServices([project]);
  const registry = createRegistry(), factory = createContextFactory({ services, projects: { resolve: async () => project } as unknown as ProjectStore, tokens: null });
  const invoke = (name: string, args: Record<string, unknown>) => registry.invoke(name, { project: project.id, ...args }, (projectRef, def, selector) => factory({ projectRef, def, ...(selector ? { board: selector } : {}), signal: new AbortController().signal, progress: () => {} }));
  const pin = await invoke("comment_pin", { board, question: "Scoped question", view: "pcb", xMm: 1, yMm: 2 });
  const id = (pin.json as { comment: { id: string } }).comment.id;
  expect(pin.json).toMatchObject({ _board: { projectId: project.id, sourceId: "a" } });
  expect((await invoke("comment_list", {})).json).toMatchObject({ comments: [] });
  expect((await invoke("comment_list", { board: { ...board, sourceId: "b" } })).json).toMatchObject({ comments: [] });
  await expect(invoke("comment_answer", { board: { ...board, sourceId: "b" }, id, answer: "Wrong source" })).rejects.toThrow();
  await invoke("comment_answer", { board, id, answer: "Source A answer" });
  await invoke("comment_resolve", { board, id });
  expect((await invoke("comment_list", { board })).json).toMatchObject({ comments: [{ id, status: "resolved", answer: "Source A answer" }] });
  const binding = await resolveNativeBoardBinding(project, board), leaf = { ...project, dir: binding.boardDir }, before = await readFile(join(leaf.dir, "comments.json"), "utf8");
  await expect(updateComments(leaf, async loaded => {
    await writeFile(join(project.dir, "fabplane.assembly.json"), "{}");
    const next = createComment(loaded, { question: "Must not save", anchor: { view: "pcb", ref: "R1" } });
    return { file: next.file, result: next.comment };
  }, () => binding.assertCurrent(binding.boardDir))).rejects.toThrow("ownership changed");
  expect(await readFile(join(leaf.dir, "comments.json"), "utf8")).toBe(before);
});
