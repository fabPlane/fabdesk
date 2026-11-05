import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BoardFile, BoardRevisionComparison, BoardTimeline, BoardView, PartLink, PartLinkList, PartLinkSuggestion } from "@fabdesk/protocol";
import { PART_LINKS_FILE } from "@fabdesk/protocol";
import { ToolError, createRegistry, type ProjectHandle } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

async function git(dir: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(stderr || stdout);
  return stdout;
}

const footprint = (ref: string, x: number, nets: [string, string] = ["SIG_A", "GND"], extra = "") => `(footprint "Lib:Part"
    (layer "F.Cu")
    ${extra}
    (at ${x} 10 0)
    (property "Reference" "${ref}" (at 0 0 0))
    (property "Value" "v" (at 0 0 0))
    (pad "1" smd rect (at -1 0) (size 1 1) (layers "F.Cu") (net 1 "${nets[0]}"))
    (pad "2" smd rect (at 1 0) (size 1 1) (layers "F.Cu") (net 2 "${nets[1]}"))
  )`;
const pcb = (...parts: string[]) => `(kicad_pcb
  (version 20241201)
  ${parts.join("\n  ")}
  (gr_rect (start 0 0) (end 50 40) (stroke (width 0.1)) (layer "Edge.Cuts"))
)`;
const BOARD_A = "boards/a/a.kicad_pcb", BOARD_B = "boards/b/b.kicad_pcb";

describe("board history and part links", () => {
  let project: ProjectHandle;
  let invoke: <T>(name: string, args?: Record<string, unknown>) => Promise<T>;
  let raw: (name: string, args?: Record<string, unknown>) => Promise<{ isError?: boolean; text?: string }>;
  const write = async (path: string, text: string) => {
    await mkdir(join(project.dir, path, ".."), { recursive: true });
    await writeFile(join(project.dir, path), text);
  };

  beforeEach(async () => {
    project = await tempProject("board-workspace");
    const registry = createRegistry(), factory = contextFactory(mockServices([project]), project);
    const call = (name: string, args: Record<string, unknown>) => registry.invoke(name, args, (ref) => factory({ def: registry.get(name)!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
    // Refusals reach clients as errors, so a refused call reads the same as one the adapter reports.
    raw = async (name, args = {}) => {
      try {
        return await call(name, args) as { isError?: boolean; text?: string };
      } catch (error) {
        if (error instanceof ToolError) return { isError: true, text: error.message };
        throw error;
      }
    };
    invoke = async <T>(name: string, args: Record<string, unknown> = {}) => ((await call(name, args)) as unknown as { json: T }).json;
    await write(BOARD_A, pcb(footprint("J1", 10), footprint("R1", 20)));
    await write(BOARD_B, pcb(footprint("J9", 10), footprint("C1", 20, ["OTHER", "GND"])));
  });

  test("lists design boards and leaves out exported copies and placement drafts", async () => {
    await write("exports/mechanical-1/boards/boards/a/a.kicad_pcb", pcb());
    await write("placement/draft-unrouted.kicad_pcb", pcb());
    await write("renders/x.kicad_pcb", pcb());
    const { boards } = await invoke<{ boards: BoardFile[] }>("board_list");
    expect(boards.map((board) => board.path).sort()).toEqual([BOARD_A, BOARD_B]);
    expect(boards.map((board) => board.name).sort()).toEqual(["a", "b"]);
  });

  test("a project with one board and no history has one entry", async () => {
    const timeline = await invoke<BoardTimeline>("board_revision_timeline", { pcbPath: BOARD_A });
    expect(timeline.entries.map((entry) => entry.kind)).toEqual(["worktree"]);
    expect(timeline.entries[0]?.changes).toBeUndefined();
    expect(timeline.git).toBe(false);
  });

  test("git commits become distinct revisions, in order, with part changes between them", async () => {
    await git(project.dir, ["init", "-q"]);
    await git(project.dir, ["config", "user.email", "t@test"]);
    await git(project.dir, ["config", "user.name", "T"]);
    await git(project.dir, ["config", "commit.gpgsign", "false"]);
    await git(project.dir, ["add", "-A"]);
    await git(project.dir, ["commit", "-qm", "one"]);
    // No change to this board: must not add a revision of it.
    await write(BOARD_B, pcb(footprint("J9", 11)));
    await git(project.dir, ["add", "-A"]);
    await git(project.dir, ["commit", "-qm", "other board only"]);
    await write(BOARD_A, pcb(footprint("J1", 13), footprint("NEW", 30)));
    await git(project.dir, ["add", "-A"]);
    await git(project.dir, ["commit", "-qm", "two"]);
    await write(BOARD_A, pcb(footprint("J1", 13)));
    const timeline = await invoke<BoardTimeline>("board_revision_timeline", { pcbPath: BOARD_A });
    expect(timeline.entries.map((entry) => entry.title)).toEqual(["one", "two", "Current file"]);
    expect(timeline.entries[1]?.changes).toMatchObject({ added: 1, removed: 1, moved: 1 });
    expect(timeline.entries[2]?.changes).toMatchObject({ added: 0, removed: 1, moved: 0 });
  });

  test("a committed revision equal to the current file appears once", async () => {
    await git(project.dir, ["init", "-q"]);
    await git(project.dir, ["config", "user.email", "t@test"]);
    await git(project.dir, ["config", "user.name", "T"]);
    await git(project.dir, ["config", "commit.gpgsign", "false"]);
    await git(project.dir, ["add", "-A"]);
    await git(project.dir, ["commit", "-qm", "one"]);
    expect((await invoke<BoardTimeline>("board_revision_timeline", { pcbPath: BOARD_A })).entries).toHaveLength(1);
  });

  test("line endings alone are not a new revision", async () => {
    const text = await readFile(join(project.dir, BOARD_A), "utf8");
    await invoke("board_revision_save", { pcbPath: BOARD_A });
    await writeFile(join(project.dir, BOARD_A), text.replace(/\n/g, "\r\n"));
    expect((await invoke<BoardTimeline>("board_revision_timeline", { pcbPath: BOARD_A })).entries).toHaveLength(1);
  });

  test("saved points need no git, and saving leaves the design untouched", async () => {
    const before = await readFile(join(project.dir, BOARD_A), "utf8");
    const saved = await invoke<{ ref: string; created: boolean }>("board_revision_save", { pcbPath: BOARD_A, label: "Before rework" });
    expect(saved.created).toBe(true);
    expect(await readFile(join(project.dir, BOARD_A), "utf8")).toBe(before);
    expect((await invoke<{ created: boolean }>("board_revision_save", { pcbPath: BOARD_A })).created).toBe(false);
    await write(BOARD_A, pcb(footprint("J1", 10)));
    const timeline = await invoke<BoardTimeline>("board_revision_timeline", { pcbPath: BOARD_A });
    expect(timeline.entries.map((entry) => entry.title)).toEqual(["Before rework", "Current file"]);
    expect(timeline.entries[1]?.changes?.removed).toBe(1);
    // Points belong to their board.
    expect((await invoke<BoardTimeline>("board_revision_timeline", { pcbPath: BOARD_B })).entries).toHaveLength(1);
  });

  test("a tampered saved point is not offered as history", async () => {
    const saved = await invoke<{ ref: string; sha256: string }>("board_revision_save", { pcbPath: BOARD_A });
    const file = join(project.dir, ".fabdesk/board-history", `${saved.sha256}.json`);
    const point = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...point, kicadPcb: pcb(footprint("FAKE", 1)) }));
    await write(BOARD_A, pcb(footprint("J1", 10)));
    expect((await invoke<BoardTimeline>("board_revision_timeline", { pcbPath: BOARD_A })).entries).toHaveLength(1);
    expect((await raw("board_revision_compare", { pcbPath: BOARD_A, from: saved.ref })).isError).toBe(true);
  });

  test("export bundles count as revisions of the same board path", async () => {
    await write(`exports/mechanical-aaaaaaaa11-22/boards/${BOARD_A}`, pcb(footprint("OLD", 5)));
    await write(`exports/mechanical-bbbbbbbb11-22/source-boards/${BOARD_B}`, pcb());
    const timeline = await invoke<BoardTimeline>("board_revision_timeline", { pcbPath: BOARD_A });
    expect(timeline.entries.map((entry) => entry.kind)).toEqual(["export", "worktree"]);
    expect(timeline.entries[1]?.changes).toMatchObject({ added: 2, removed: 1 });
  });

  test("compares two revisions and only includes drawings on request", async () => {
    const { ref } = await invoke<{ ref: string }>("board_revision_save", { pcbPath: BOARD_A });
    await write(BOARD_A, pcb(footprint("J1", 13), footprint("NEW", 30)));
    const plain = await invoke<BoardRevisionComparison>("board_revision_compare", { pcbPath: BOARD_A, from: ref });
    expect(plain.summary).toMatchObject({ added: 1, removed: 1, moved: 1 });
    expect(plain.from.drawing).toBeUndefined();
    const drawn = await invoke<BoardRevisionComparison>("board_revision_compare", { pcbPath: BOARD_A, from: ref, drawings: true });
    expect(drawn.from.drawing).toContain('data-ref="R1"');
    expect(drawn.to.drawing).toContain('data-ref="NEW"');
    expect(drawn.to.parts.find((part) => part.ref === "NEW")?.nets).toEqual(["SIG_A", "GND"]);
  });

  test("another PCB file can be the older side", async () => {
    const result = await invoke<BoardRevisionComparison>("board_revision_compare", { pcbPath: BOARD_A, from: `file:${BOARD_B}` });
    expect(result.summary).toMatchObject({ added: 2, removed: 2 });
  });

  test("paths outside the project and non-PCB files are refused", async () => {
    for (const pcbPath of ["../outside.kicad_pcb", "/etc/passwd", "C:/x.kicad_pcb", "NOTES.md"]) {
      expect((await raw("board_view", { pcbPath })).isError).toBe(true);
    }
    expect((await raw("board_revision_compare", { pcbPath: BOARD_A, from: "file:../../outside.kicad_pcb" })).isError).toBe(true);
    expect((await raw("board_revision_compare", { pcbPath: BOARD_A, from: "not a ref!" })).isError).toBe(true);
    expect((await raw("board_view", { pcbPath: "boards/none.kicad_pcb" })).isError).toBe(true);
  });

  test("board_view returns parts in outline coordinates", async () => {
    await write(BOARD_A, `(kicad_pcb ${footprint("J1", 110)} (gr_rect (start 100 0) (end 150 40) (layer "Edge.Cuts")))`);
    const view = await invoke<BoardView>("board_view", { pcbPath: BOARD_A, drawing: true });
    expect(view.parts[0]).toMatchObject({ ref: "J1", x: 10, y: 10 });
    expect(view.size).toEqual({ width: 50, height: 40 });
    expect(view.drawing).toContain('data-ref="J1"');
  });

  const link = async () => (await invoke<{ link: PartLink }>("connection_add", { a: { boardPath: BOARD_A, ref: "J1" }, b: { boardPath: BOARD_B, ref: "J9" } })).link;
  const onlyLink = async () => (await invoke<PartLinkList>("connection_list")).links[0]!;

  test("links two parts, saves a git-tracked file and changes neither board", async () => {
    const before = await readFile(join(project.dir, BOARD_A), "utf8");
    const created = await link();
    expect(created.id).toMatch(/^lnk_/);
    expect(await readFile(join(project.dir, BOARD_A), "utf8")).toBe(before);
    expect(JSON.parse(await readFile(join(project.dir, PART_LINKS_FILE), "utf8")).links).toHaveLength(1);
    const listed = await onlyLink();
    expect(listed.state).toBe("current");
    expect(listed.sharedNets).toEqual([{ net: "SIG_A", aPin: "1", bPin: "1" }, { net: "GND", aPin: "2", bPin: "2" }]);
  });

  test("refuses unknown parts, the same part twice and duplicates in either direction", async () => {
    expect((await raw("connection_add", { a: { boardPath: BOARD_A, ref: "NOPE" }, b: { boardPath: BOARD_B, ref: "J9" } })).isError).toBe(true);
    expect((await raw("connection_add", { a: { boardPath: BOARD_A, ref: "J1" }, b: { boardPath: BOARD_A, ref: "J1" } })).isError).toBe(true);
    await link();
    expect((await raw("connection_add", { a: { boardPath: BOARD_B, ref: "J9" }, b: { boardPath: BOARD_A, ref: "J1" } })).isError).toBe(true);
    expect((await invoke<PartLinkList>("connection_list")).links).toHaveLength(1);
  });

  test("two parts on one board can be linked", async () => {
    const created = (await invoke<{ link: PartLink }>("connection_add", { a: { boardPath: BOARD_A, ref: "J1" }, b: { boardPath: BOARD_A, ref: "R1" } })).link;
    expect(created.a.boardPath).toBe(created.b.boardPath);
  });

  test("only a change to a linked part asks for review, and review clears it", async () => {
    await link();
    await write(BOARD_A, pcb(footprint("J1", 10), footprint("R1", 25)));
    expect((await onlyLink()).state).toBe("current");
    await write(BOARD_A, pcb(footprint("J1", 12), footprint("R1", 25)));
    const moved = await onlyLink();
    expect(moved.state).toBe("needs-review");
    expect(moved.reasons).toEqual(["J1: moved on the board"]);
    await invoke("connection_review", { id: moved.id });
    expect((await onlyLink()).state).toBe("current");
    await write(BOARD_A, pcb(footprint("J1", 12, ["CHANGED", "GND"]), footprint("R1", 25)));
    expect((await onlyLink()).reasons).toEqual(["J1: pins or nets changed"]);
  });

  test("a board moved on the sheet does not ask for review", async () => {
    await link();
    await write(BOARD_A, `(kicad_pcb ${footprint("J1", 110)} ${footprint("R1", 120)} (gr_rect (start 100 0) (end 150 40) (layer "Edge.Cuts")))`);
    expect((await onlyLink()).state).toBe("current");
  });

  test("a deleted part or board is reported and cannot be marked reviewed", async () => {
    await link();
    await write(BOARD_A, pcb(footprint("R1", 20)));
    const missing = await onlyLink();
    expect(missing.state).toBe("missing");
    expect(missing.reasons).toEqual(["J1 is no longer on its board"]);
    expect((await raw("connection_review", { id: missing.id })).isError).toBe(true);
    await Bun.file(join(project.dir, BOARD_B)).delete();
    expect((await onlyLink()).reasons).toContain(`${BOARD_B} is missing`);
    await invoke("connection_remove", { id: missing.id });
    expect((await invoke<PartLinkList>("connection_list")).links).toEqual([]);
  });

  test("concurrent writers do not lose links", async () => {
    await Promise.all([
      invoke("connection_add", { a: { boardPath: BOARD_A, ref: "J1" }, b: { boardPath: BOARD_B, ref: "J9" } }),
      invoke("connection_add", { a: { boardPath: BOARD_A, ref: "R1" }, b: { boardPath: BOARD_B, ref: "J9" } }),
      invoke("connection_add", { a: { boardPath: BOARD_A, ref: "J1" }, b: { boardPath: BOARD_B, ref: "C1" } }),
    ]);
    expect((await invoke<PartLinkList>("connection_list")).links).toHaveLength(3);
  });

  test("a corrupt links file is an error, never silently emptied", async () => {
    await write(PART_LINKS_FILE, "{ not json");
    expect((await raw("connection_list")).isError).toBe(true);
    expect((await raw("connection_add", { a: { boardPath: BOARD_A, ref: "J1" }, b: { boardPath: BOARD_B, ref: "J9" } })).isError).toBe(true);
    expect(await readFile(join(project.dir, PART_LINKS_FILE), "utf8")).toBe("{ not json");
  });

  test("a revision comparison names linked parts it affects on other boards", async () => {
    await link();
    const { ref } = await invoke<{ ref: string }>("board_revision_save", { pcbPath: BOARD_A });
    await write(BOARD_A, pcb(footprint("J1", 14), footprint("R1", 20)));
    const result = await invoke<BoardRevisionComparison>("board_revision_compare", { pcbPath: BOARD_A, from: ref });
    expect(result.impacts).toHaveLength(1);
    expect(result.impacts[0]).toMatchObject({ changedRef: "J1", change: "moved", peer: { boardPath: BOARD_B, ref: "J9" } });
  });

  test("suggestions rank signal nets and ignore a lone shared rail", async () => {
    await write(BOARD_B, pcb(footprint("J9", 10), footprint("C1", 20, ["POWERISH", "GND"]), footprint("U1", 30, ["SIG_A", "UNIQUE"])));
    const { suggestions } = await invoke<{ suggestions: PartLinkSuggestion[] }>("connection_suggest", { boardA: BOARD_A, boardB: BOARD_B });
    expect(suggestions[0]).toMatchObject({ a: { ref: "J1" }, b: { ref: "J9" }, connectors: true });
    expect(suggestions.some((row) => row.b.ref === "C1")).toBe(false);
    expect(suggestions.some((row) => row.b.ref === "U1")).toBe(true);
    await write(BOARD_B, pcb(footprint("C1", 20, ["ONLY", "GND"])));
    expect((await invoke<{ suggestions: PartLinkSuggestion[] }>("connection_suggest", { boardA: BOARD_A, boardB: BOARD_B })).suggestions).toEqual([]);
    // A suggestion is never saved by itself.
    expect((await invoke<PartLinkList>("connection_list")).links).toEqual([]);
  });

  test("connections declared by an enclosure design appear read-only", async () => {
    const design = { version: 1, mode: "generated", confirmed: false, source: null, space: { x: 0, y: 0, width: 100, depth: 100, height: 30, wall: 2, floor: 2, lid: 2, clearance: 1 }, boards: [{ path: BOARD_A, x: 0, y: 0, z: 0, rotation: 0 }, { path: BOARD_B, x: 0, y: 0, z: 0, rotation: 0 }], connections: [{ id: "c1", from: { boardPath: BOARD_A, ref: "J1" }, to: { boardPath: BOARD_B, ref: "J9" }, length: 100, slack: 10 }], mounts: [], openings: [], obstacles: [] };
    await write("cad/enclosure-design.json", JSON.stringify(design));
    const list = await invoke<PartLinkList>("connection_list");
    expect(list.links).toEqual([]);
    if (list.declared.length) expect(list.declared[0]).toMatchObject({ source: "mechanical", a: { ref: "J1" }, b: { ref: "J9" } });
  });
});
