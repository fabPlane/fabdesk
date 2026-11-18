import { describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  netlistJsonFrontend,
  checkNetlistJson,
} from "../../../vendor/fab_pcb/packages/compile/src/frontends/netlist-json";
import { validateNetlist } from "../../../vendor/fab_pcb/packages/compile/src/netlist";
import { createRegistry } from "../src";
import { toCallToolResult, wantsStructured } from "../src/adapters/mcp";
import { COMPILER_SOURCE_GUIDE } from "../src/tools/compiler-source-guide";
import { contextFactory, mockServices, tempProject } from "./mock-services";

async function invokeBuild(input: string | undefined, errorType?: string) {
  const project = await tempProject("source-guide");
  const board = join(project.dir, "board.kicad_pcb");
  await writeFile(board, "canonical sentinel");
  const base = mockServices([project]);
  const services = mockServices([project], {
    design: {
      ...base.design,
      build: async () => {
        const parsed = await netlistJsonFrontend.build({
          kind: "netlist-json",
          entrypoint: "circuit.netlist.json",
          files: input === undefined ? {} : { "circuit.netlist.json": input },
        });
        const errors = errorType
          ? [{ type: errorType, message: "native validation rejected" }]
          : parsed.diagnostics
              .filter((d) => d.severity === "error")
              .map((d) => ({ type: d.code, message: d.message }));
        return {
          ok: errors.length === 0,
          durationMs: 1,
          errors,
          warnings: [],
          counts: { components: 0, nets: 0, footprintsAdded: 0, footprintsPlaced: 0 },
        };
      },
    },
  });
  const registry = createRegistry();
  const factory = contextFactory(services, project);
  const output = await registry.invoke("circuit_build", {}, (ref) =>
    factory({
      def: registry.get("circuit_build")!,
      projectRef: ref,
      signal: new AbortController().signal,
      progress: () => {},
    }),
  );
  expect(await readFile(board, "utf8")).toBe("canonical sentinel");
  return output;
}

describe("selected compiler source guidance", () => {
  test.each([
    undefined,
    "{",
    "{}",
    JSON.stringify({ netlist: { components: [], nets: [{ name: "A", nodes: ["R1.1"] }] } }),
  ])(
    "malformed input receives actionable format and a validator-accepted next input: %s",
    async (input) => {
      const rejected = await invokeBuild(input);
      expect(rejected.isError).toBe(true);
      const json = rejected.json as { sourceGuide: typeof COMPILER_SOURCE_GUIDE };
      expect(json.sourceGuide).toBeDefined();
      expect(rejected.text).toContain("libSource: {lib, part}");
      expect(rejected.text).toContain("nodes: [{ref, pin}]");
      const nextInput = JSON.stringify(json.sourceGuide.example);
      const shape = checkNetlistJson(JSON.parse(nextInput), "circuit.netlist.json");
      expect(shape.diagnostics).toEqual([]);
      expect(shape.file).not.toBeNull();
      expect(validateNetlist(shape.file!.netlist).filter((d) => d.severity === "error")).toEqual(
        [],
      );
      const accepted = await invokeBuild(nextInput);
      expect(accepted.isError).toBe(false);
      expect((accepted.json as Record<string, unknown>).sourceGuide).toBeUndefined();
    },
  );
  test("electrical rejection retains its error without unrelated format help", async () => {
    const rejected = await invokeBuild(JSON.stringify(COMPILER_SOURCE_GUIDE.example), "erc_errors");
    expect(rejected.isError).toBe(true);
    expect((rejected.json as Record<string, unknown>).sourceGuide).toBeUndefined();
    expect(rejected.text).toContain("native validation rejected");
  });
  test("format help is bounded", () =>
    expect(JSON.stringify(COMPILER_SOURCE_GUIDE).length).toBeLessThan(2500));
});

test("schema guide reaches Claude text and keeps JSON for other clients", async () => {
  const registry = createRegistry();
  const project = await tempProject("schema-guide");
  const factory = contextFactory(mockServices([project]), project);
  const output = await registry.invoke("circuit_source", { action: "schema" }, (ref) =>
    factory({ def: registry.get("circuit_source")!, projectRef: ref, signal: new AbortController().signal, progress: () => {} }));
  const claude = await toCallToolResult(output, { structured: wantsStructured(output, "claude-code") });
  expect(claude.structuredContent).toBeUndefined();
  const text = claude.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  expect(text).toContain("libSource: {lib, part}");
  expect(text).toContain("nodes: [{ref, pin}]");
  expect(text).toContain(JSON.stringify(COMPILER_SOURCE_GUIDE.example));
  const other = await toCallToolResult(output);
  expect(other.structuredContent).toHaveProperty("schema");
  expect(other.structuredContent).toHaveProperty("example");
});
