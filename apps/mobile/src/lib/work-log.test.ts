import { describe, expect, test } from "bun:test";
import type { MessagePart } from "@fabdesk/protocol";
import { workLog, workLogDetails, workLogLabel } from "./work-log";

const use = (name: string, input: unknown = {}): MessagePart => ({
  type: "tool_use",
  id: `${name}-${Math.random()}`,
  name,
  input,
});
const result = (isError?: boolean): MessagePart => ({
  type: "tool_result",
  id: "x",
  output: "",
  ...(isError === undefined ? {} : { isError }),
});

describe("workLog", () => {
  test("a turn with no tools has nothing to say", () => {
    expect(workLog([{ type: "text", text: "hi" }])).toEqual({
      filesWritten: [],
      renders: 0,
      exports: [],
      routeRuns: 0,
      toolCalls: 0,
      errors: 0,
    });
    expect(workLogLabel(workLog([]))).toBeNull();
  });

  test("counts the daemon's own tools, MCP prefix or not", () => {
    const log = workLog([
      use("mcp__fabdesk__project_write_file", { path: "circuit.netlist.json", content: "" }),
      result(),
      use("mcp__fabdesk__circuit_build"),
      result(),
      use("mcp__fabdesk__route_run"),
      result(),
      use("render_board", { view: "top" }),
      result(),
      use("render_glb"),
      result(),
      use("export_gerbers"),
      result(),
    ]);
    expect(log).toEqual({
      filesWritten: ["circuit.netlist.json"],
      renders: 2,
      exports: ["gerbers"],
      routeRuns: 1,
      toolCalls: 6,
      errors: 0,
    });
    expect(workLogLabel(log)).toBe("1 file · 2 renders · 1 export · 1 route run");
  });

  test("reads Claude Code's editors and dedupes a file edited twice", () => {
    const log = workLog([
      use("Write", { file_path: "/p/a.ts", content: "" }),
      use("Edit", { file_path: "/p/a.ts", old_string: "", new_string: "" }),
      use("NotebookEdit", { notebook_path: "/p/n.ipynb" }),
      use("Bash", { command: "ls" }),
    ]);
    expect(log.filesWritten).toEqual(["/p/a.ts", "/p/n.ipynb"]);
    expect(workLogLabel(log)).toBe("2 files");
  });

  test("reads the files out of a Codex apply_patch", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      "-x",
      "+y",
      "*** Add File: src/b.ts",
      "+hello",
      "*** End Patch",
    ].join("\n");
    expect(workLog([use("apply_patch", { patch })]).filesWritten).toEqual(["src/a.ts", "src/b.ts"]);
    expect(workLog([use("apply_patch", { input: patch })]).filesWritten).toHaveLength(2);
    expect(workLog([use("apply_patch", { patch: 42 })]).filesWritten).toEqual([]);
  });

  test("falls back to the tool-call count and appends failures", () => {
    const log = workLog([use("circuit_query"), result(), use("kicad_stats"), result(true)]);
    expect(workLogLabel(log)).toBe("2 tool calls · 1 failed");
    expect(workLogLabel(workLog([use("route_run"), result(true)]))).toBe("1 route run · 1 failed");
  });

  test("exports dedupe and the details list files and exports by name", () => {
    const log = workLog([
      use("export_bom"),
      use("export_bom"),
      use("export_zip"),
      use("project_write_file", { path: "x.json" }),
    ]);
    expect(log.exports).toEqual(["bom", "zip"]);
    expect(workLogDetails(log)).toEqual(["wrote x.json", "exported bom", "exported zip"]);
    expect(workLogDetails(workLog([use("render_board")]))).toEqual([]);
  });

  test("tolerates a tool input that is not an object", () => {
    expect(workLog([use("Write", "nope"), use("project_write_file", null)]).filesWritten).toEqual(
      [],
    );
  });
});
