import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BOARD_COMMENTS_CONTRACT, commentAnchorLabel } from "@fabdesk/protocol";
import { createComment, createRegistry, updateComments } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

async function invoke(name: string, args: Record<string, unknown> = {}) {
  const project = await tempProject("comments");
  const services = mockServices([project]);
  const registry = createRegistry();
  const factory = contextFactory(services, project);
  const result = await registry.invoke(name, args, (ref) =>
    factory({
      def: registry.get(name)!,
      projectRef: ref,
      signal: new AbortController().signal,
      progress: () => {},
    }),
  );
  return { project, result };
}

describe("board comment tools", () => {
  test("pins a question, lists it, answers in place, and writes NOTES.md", async () => {
    const project = await tempProject("comments");
    const services = mockServices([project]);
    const registry = createRegistry();
    const factory = contextFactory(services, project);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      registry.invoke(name, args, (ref) =>
        factory({
          def: registry.get(name)!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );

    const pinned = await call("comment_pin", {
      question: "What does this chip do here?",
      view: "pcb",
      x: 12.4,
      y: 8,
      ref: "U12",
      pad: "1",
      net: "SPI.CS",
      author: "maya",
    });
    const comment = pinned.json as { comment: { id: string; status: string; anchor: { ref?: string } } };
    expect(comment.comment.status).toBe("open");
    expect(comment.comment.anchor.ref).toBe("U12");
    expect(pinned.text).toContain("U12 · pad 1 · SPI.CS");

    const listed = await call("comment_list", {});
    const listJson = listed.json as { comments: Array<{ id: string }>; notes: { chars: number } };
    expect(listJson.comments).toHaveLength(1);
    expect(listJson.notes.chars).toBe(0);

    const answered = await call("comment_answer", {
      id: comment.comment.id,
      answer: "U12 is the SPI flash; pad 1 is chip-select on SPI.CS.",
    });
    expect((answered.json as { comment: { status: string; answeredBy?: string } }).comment.status).toBe(
      "answered",
    );
    expect((answered.json as { comment: { answeredBy?: string } }).comment.answeredBy).toBe("agent");

    await call("comment_resolve", { id: comment.comment.id });
    await call("notes_write", { content: "# Board notes\n\nSPI flash sits at U12.\n" });
    const notes = await call("notes_read", {});
    expect((notes.json as { content: string }).content).toContain("SPI flash sits at U12");

    const raw = JSON.parse(await readFile(join(project.dir, "comments.json"), "utf8")) as {
      contract: { name: string };
      comments: Array<{ status: string; answer?: string }>;
    };
    expect(raw.contract).toEqual(BOARD_COMMENTS_CONTRACT);
    expect(raw.comments[0]?.status).toBe("resolved");
    expect(raw.comments[0]?.answer).toContain("SPI flash");
    expect(await readFile(join(project.dir, "NOTES.md"), "utf8")).toContain("U12");
  });

  test("parallel comment_pin / comment_answer / updateComments never lose a write", async () => {
    const project = await tempProject("comments-parallel");
    const services = mockServices([project]);
    const registry = createRegistry();
    const factory = contextFactory(services, project);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      registry.invoke(name, args, (ref) =>
        factory({ def: registry.get(name)!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }),
      );
    const pinned = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => call("comment_pin", { question: `Tool ${i}?`, view: "pcb", ref: `U${i}` })),
      ...Array.from({ length: 4 }, (_, i) =>
        updateComments(project, (file) => {
          const { file: next, comment } = createComment(file, { question: `Http ${i}?`, anchor: { view: "pcb", ref: `J${i}` } });
          return { file: next, result: { json: { comment } } };
        }),
      ),
    ]);
    const ids = pinned.map((r) => (r.json as { comment: { id: string } }).comment.id);
    await Promise.all(ids.map((id, i) => (i % 2 ? call("comment_resolve", { id }) : call("comment_answer", { id, answer: `A${i}` }))));
    const raw = JSON.parse(await readFile(join(project.dir, "comments.json"), "utf8")) as {
      comments: Array<{ id: string; status: string }>;
    };
    expect(raw.comments.map((c) => c.id).sort()).toEqual([...ids].sort());
    expect(raw.comments.filter((c) => c.status === "answered")).toHaveLength(5);
    expect(raw.comments.filter((c) => c.status === "resolved")).toHaveLength(5);
  });

  test("rejects a pin with no locator", async () => {
    await expect(invoke("comment_pin", { question: "What is this?", view: "pcb" })).rejects.toThrow(
      /anchor|click|ref|net|area/i,
    );
  });

  test("labels match the protocol helper", () => {
    expect(commentAnchorLabel({ view: "schematic", ref: "J1", pin: "3", net: "D+" })).toBe(
      "J1 · pin 3 · D+",
    );
  });
});
