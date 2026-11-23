import { expect, test } from "bun:test";
import { z } from "zod/v4";
import { ProjectAssembly } from "./assembly";
import { BoardArtworkSettings } from "./board-artwork";

const assembly = {
  contract: "fabplane.assembly.v1",
  sources: [{ id: "controller", name: "Controller", location: "project", directory: "." }],
  instances: [{ id: "controller-1", sourceId: "controller", name: "Controller" }],
  connections: [],
};

test("oversized assembly input produces one size error instead of thousands of element errors", () => {
  const result = ProjectAssembly.safeParse({ ...assembly, sources: Array(10_000).fill(null) });
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Oversized sources were accepted");
  expect(result.error.issues.length).toBe(1);
  expect(result.error.issues[0]).toMatchObject({
    code: "too_big",
    path: ["sources"],
    maximum: 128,
  });
  expect(ProjectAssembly.safeParse(assembly).success).toBe(true);
});

test("artwork layer count is checked before validating individual layers", async () => {
  const result = await BoardArtworkSettings.shape.layers.safeParseAsync(Array(10_000).fill(null));
  expect(result.success).toBe(false);
  if (result.success) throw new Error("Oversized layers were accepted");
  expect(result.error.issues.length).toBe(1);
  expect(result.error.issues[0]).toMatchObject({ code: "too_big", maximum: 3 });
  expect(BoardArtworkSettings.shape.layers.parse(["silk", "mask", "copper"])).toEqual([
    "silk",
    "mask",
    "copper",
  ]);
});

test("constrained array, map and set validators do not inspect oversized collection members", () => {
  let parsed = 0;
  const element = z.string().refine(() => {
    parsed++;
    return true;
  });
  const inputs = [
    [z.array(element).max(2), ["a", "b", "c"]],
    [
      z.map(element, element).max(2),
      new Map([
        ["a", "a"],
        ["b", "b"],
        ["c", "c"],
      ]),
    ],
    [z.set(element).max(2), new Set(["a", "b", "c"])],
  ] as const;
  for (const [schema, value] of inputs) {
    const result = schema.safeParse(value);
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Oversized collection was accepted");
    expect(result.error.issues.length).toBe(1);
    expect(result.error.issues[0]?.code).toBe("too_big");
  }
  expect(parsed).toBe(0);
});
