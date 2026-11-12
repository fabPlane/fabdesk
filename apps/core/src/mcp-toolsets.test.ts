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
    for (const n of [...BOARD_START_TOOLS, "load_toolset", "verify_drc", "render_view", "board_job"]) expect(names).toContain(n);
    for (const n of ["schematic_edit", "native_edit_transaction", "pcb_edit_graphics", "circuit_build"]) expect(names).not.toContain(n);
  });
  test("the placeholder list names only tools that exist", () => {
    const reg = createRegistry();
    for (const n of BOARD_START_TOOLS) expect(reg.get(n)).toBeDefined();
  });
});
