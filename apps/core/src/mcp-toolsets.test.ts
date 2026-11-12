import { describe, expect, test } from "bun:test";
import { BOARD_START_TOOLS, boardStartTools, initialToolsetsFor, nativeToolsFor, NATIVE_AGENT_TOOLS } from "./mcp-sessions";
import { createRegistry } from "@fabdesk/tools";

describe("initialToolsetsFor", () => {
  test("defaults, the full set, and a comma list added to the defaults", () => {
    expect(initialToolsetsFor(null)).toEqual(["circuit", "verify", "render"]);
    expect(initialToolsetsFor("all")).toContain("board");
    expect(initialToolsetsFor("board")).toEqual(["circuit", "verify", "render", "board"]);
    expect(initialToolsetsFor("board,bogus,shopping")).toEqual(["circuit", "verify", "render", "shopping", "board"]);
  });
});

describe("nativeToolsFor", () => {
  const registry = { byToolset: (id: string) => (id === "board" ? [{ name: "board_job" }, { name: "board_check" }] : []) } as never;
  test("the fixed native list gains a requested toolset's tools, nothing otherwise", () => {
    expect(nativeToolsFor(null, registry)).toEqual([...NATIVE_AGENT_TOOLS]);
    expect(nativeToolsFor("board", registry)).toEqual([...NATIVE_AGENT_TOOLS, "board_job", "board_check"]);
    expect(nativeToolsFor("bogus", registry)).toEqual([...NATIVE_AGENT_TOOLS]);
  });
});

describe("boardStartTools", () => {
  const registry = { byToolset: (id: string) => ({ core: [{ name: "load_toolset" }], verify: [{ name: "verify_drc" }], render: [{ name: "render_view" }], board: [{ name: "board_job" }] } as Record<string, Array<{ name: string }>>)[id] ?? [] } as never;
  test("board-reading tools plus core, verify, render and board; no authoring tools", () => {
    const names = boardStartTools(registry);
    for (const n of [...BOARD_START_TOOLS, "load_toolset", "render_view", "board_job"]) expect(names).toContain(n);
    // board_check supersedes verify_drc: one way to do the job in the start set
    expect(names).not.toContain("verify_drc");
    for (const n of ["schematic_edit", "native_edit_transaction", "pcb_edit_graphics", "circuit_build"]) expect(names).not.toContain(n);
  });
  test("with the real registry: board tools replace verify_drc; uncovered tools stay", () => {
    const names = boardStartTools(createRegistry());
    for (const n of ["board_check", "board_route", "board_edit", "board_review", "board_release", "pcb_inspect", "schematic_inspect", "render_view", "route_run", "verify_erc"]) expect(names).toContain(n);
    for (const n of ["verify_drc", "verify_gate", "release_build"]) expect(names).not.toContain(n);
  });
  test("the placeholder list names only tools that exist", () => {
    const reg = createRegistry();
    for (const n of BOARD_START_TOOLS) expect(reg.get(n)).toBeDefined();
  });
});
