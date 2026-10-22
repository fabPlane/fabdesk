import { expect, test } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { kicadIpcSessionDiagnostics } from "../src/tools/diagnostic-evidence";
import { contextFactory, mockServices, tempProject } from "./mock-services";

test("live dangling diagnostics keep item IDs and their informational authority", () => {
  const diagnostics = kicadIpcSessionDiagnostics({
    errors: 0,
    warnings: 1,
    issues: [
      {
        type: "ERCET_UNCONNECTED_WIRE_ENDPOINT",
        description: "Unconnected wire endpoint",
        itemIds: ["wire-id"],
      },
    ],
    issueCount: 1,
    danglingItemIds: ["wire-id"],
  });
  expect(diagnostics.authority).toBe("informational-not-saved-file-erc");
  expect(diagnostics.counts).toEqual({ errors: 0, warnings: 1 });
  expect(diagnostics.danglingItemIds).toEqual(["wire-id"]);
  expect(diagnostics.issues?.[0]?.itemIds).toEqual(["wire-id"]);
});

test("named fabrication archive contains the existing exports and rejects escaping names", async () => {
  const project = await tempProject("named-fabrication");
  try {
    await mkdir(join(project.dir, "exports/gerbers"), { recursive: true });
    await Bun.write(join(project.dir, "exports/gerbers/board-F_Cu.gbr"), "GERBER");
    await Bun.write(join(project.dir, "exports/bom.csv"), "BOM");
    const services = mockServices([project]),
      registry = createRegistry(),
      factory = contextFactory(services, project);
    const call = (input: any) =>
      registry.invoke("export_zip", input, () =>
        factory({
          def: registry.get("export_zip")!,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );
    const output = await call({ filename: "controller-fabrication.zip" });
    const data: any = output.json;
    expect(data.path).toBe(join(project.dir, "exports/controller-fabrication.zip"));
    expect(data.files).toEqual(["gerbers/board-F_Cu.gbr", "bom.csv"]);
    expect(data.missing).toEqual(["positions.csv"]);
    const bytes = await readFile(data.path);
    expect(bytes.subarray(0, 2).toString()).toBe("PK");
    expect(bytes.toString()).toContain("GERBER");
    await expect(call({ filename: "../escape.zip" })).rejects.toThrow();
  } finally {
    await rm(project.dir, { recursive: true, force: true });
  }
});
