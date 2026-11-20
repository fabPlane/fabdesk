import { test, expect } from "bun:test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { toCallToolResult, wantsStructured } from "../src/adapters/mcp";
import { createRegistry } from "../src";
import { tempProject, mockServices, contextFactory } from "./mock-services";

test("representation registry selects imported native path and preserves source on unavailable runtime", async () => {
  const project = await tempProject("representation");
  await mkdir(join(project.dir, "native"));
  const path = "native/import.kicad_pcb";
  await writeFile(join(project.dir, path), "(broken native)");
  await writeFile(join(project.dir, "fabdesk.json"), JSON.stringify({ importedBoard: { path } }));
  const base = mockServices([project]);
  let isolated = false;
  const services = {
    ...base,
    kicad: {
      ...base.kicad,
      resolveCli: async (options?: { env: NodeJS.ProcessEnv; cwd: string }) => {
        isolated = !!options?.env.KICAD_CONFIG_HOME && !!options.env.XDG_CONFIG_HOME;
        return null;
      },
    },
  };
  const registry = createRegistry(),
    factory = contextFactory(services, project);
  const result = await registry.invoke("board_representation", {}, (ref) =>
    factory({
      def: registry.get("board_representation")!,
      projectRef: ref,
      signal: new AbortController().signal,
      progress: () => {},
    }),
  );
  const detail = await registry.invoke(
    "board_representation",
    { action: "inspect", detail: "source" },
    (ref) =>
      factory({
        def: registry.get("board_representation")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
  );
  for (const output of [result, detail])
    for (const client of ["claude-code", "codex"]) {
      const converted = await toCallToolResult(output, {
        structured: wantsStructured(output, client),
      });
      const visible = converted.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("");
      expect(visible).toContain("unresolved");
      expect(visible).toContain(output === detail ? "base64" : "components");
    }
  expect(isolated).toBe(true);
  expect(result.json).toMatchObject({
    board: path,
    sourceStatus: "failed",
    check: { status: "failed", counts: null },
  });
  expect(await readFile(join(project.dir, path), "utf8")).toBe("(broken native)");
});
