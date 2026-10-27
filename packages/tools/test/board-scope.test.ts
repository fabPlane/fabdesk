import { z } from "zod/v4";
import { expect, test } from "bun:test";
import { defineTool, makeContext, ToolRegistry, type ProjectHandle } from "../src";
import { mockServices } from "./mock-services";
const selection = { sourceId: "io", manifestSha256: "a".repeat(64) };
const project: ProjectHandle = { id: "project", name: "Project / I/O", dir: "/project/boards/io", manifest: () => { throw new Error("unused"); }, updateManifest: async () => { throw new Error("unused"); } };
const services = mockServices([]);
function probe(handler: (args: Record<string, unknown>) => Promise<{ json: unknown }>) {
  return defineTool({ name: "source_probe", title: "Source probe", description: "Test source routing", toolset: "core", boardScoped: true, inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }, handler });
}

test("registry strips transport selectors, executes the verified scope and qualifies primitive results", async () => {
  let scoped = 0, handled = 0;
  const registry = new ToolRegistry([probe(async args => { handled++; expect(args).toEqual({}); return { json: null }; })]);
  const result = await registry.invoke("source_probe", { project: "project", board: selection }, (projectRef, _def, board) => {
    expect(projectRef).toBe("project"); expect(Object.isFrozen(board)).toBe(true);
    return makeContext({ services, project, board: board!, runInScope: async operation => { scoped++; return operation(); } });
  });
  expect(scoped).toBe(1); expect(handled).toBe(1);
  expect(result.json).toMatchObject({ value: null, _board: { projectId: "project", ...selection } });
});
test("mismatched, missing execution and implicit host board scopes never reach handlers", async () => {
  let handled = 0;
  const registry = new ToolRegistry([probe(async () => { handled++; return { json: {} }; })]);
  const execute = async <T>(operation: () => Promise<T>) => operation();
  await expect(registry.invoke("source_probe", { board: selection }, () => makeContext({ services, project, board: { ...selection, sourceId: "other" }, runInScope: execute }))).rejects.toThrow("did not establish");
  await expect(registry.invoke("source_probe", { board: selection }, () => makeContext({ services, project, board: selection }))).rejects.toThrow("did not establish");
  await expect(registry.invoke("source_probe", {}, () => makeContext({ services, project, board: selection, runInScope: execute }))).rejects.toThrow("implicit board");
  expect(handled).toBe(0);
});
test("a scope rejected immediately before execution does not invoke the handler", async () => {
  let handled = 0;
  const registry = new ToolRegistry([probe(async () => { handled++; return { json: {} }; })]);
  await expect(registry.invoke("source_probe", { board: selection }, () => makeContext({ services, project, board: selection, runInScope: async () => { throw new Error("ownership changed"); } }))).rejects.toThrow("ownership changed");
  expect(handled).toBe(0);
});
test("board selection is reserved for explicitly supported project tool definitions", () => {
  const definition = probe(async () => ({ json: {} }));
  expect(() => new ToolRegistry([{ ...definition, scope: "global" }])).toThrow("project-scoped");
  expect(() => new ToolRegistry([{ ...definition, inputSchema: { board: z.string() } }])).toThrow("reserve the board selector");
  const schema = new ToolRegistry([definition]).jsonSchema(definition) as { properties: Record<string, unknown> };
  expect(schema.properties["board"]).toBeDefined();
});
