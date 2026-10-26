import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { ToolRegistry, defineTool } from "../src/registry";
import { pcb_place } from "../src/tools/pcb";
import { schematic_edit } from "../src/tools/schematic";

const noContext = () => {
  throw new Error("validation must precede context and mutation");
};

test("Qwen placement rejects misplaced coordinates before any mutation", async () => {
  const registry = new ToolRegistry([pcb_place]);
  await expect(
    registry.invoke(
      "pcb_place",
      {
        placements: [{ reference: "D1", x: 27, y: 23, flip: true }],
      },
      noContext,
    ),
  ).rejects.toThrow("use position: {x, y} in mm");
});

test("nested unknown fields in other native mutations fail closed", async () => {
  const registry = new ToolRegistry([pcb_place, schematic_edit]);
  await expect(
    registry.invoke(
      "pcb_place",
      {
        placements: [{ reference: "D1", referenceField: { visible: true, typo: 1 } }],
      },
      noContext,
    ),
  ).rejects.toThrow("typo");
  await expect(
    registry.invoke(
      "schematic_edit",
      {
        symbolUpdates: [{ reference: "R1", value: "10k", typo: 1 }],
      },
      noContext,
    ),
  ).rejects.toThrow("typo");
});

test("declared records and arbitrary payloads retain their keys", async () => {
  const registry = new ToolRegistry([
    defineTool({
      name: "test_mutation",
      title: "test",
      toolset: "core",
      scope: "global",
      description: "test",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      inputSchema: { fields: z.record(z.string(), z.string()), payload: z.unknown() },
      handler: async (args) => ({ json: args }),
    }),
  ]);
  const result = await registry.invoke(
    "test_mutation",
    { fields: { Custom: "ok" }, payload: { x: 1, custom: true } },
    () => ({ project: null }) as never,
  );
  expect(result.json).toMatchObject({ fields: { Custom: "ok" }, payload: { x: 1, custom: true } });
});

test("adapter pre-validation rejects coordinates before Zod can strip them", () => {
  const parsed = new ToolRegistry([pcb_place]).inputObject(pcb_place).safeParse({
    placements: [{ reference: "D1", x: 27, y: 23, flip: true }],
  });
  expect(parsed.success).toBe(false);
  if (!parsed.success) expect(parsed.error.message).toContain("use position: {x, y} in mm");
});
