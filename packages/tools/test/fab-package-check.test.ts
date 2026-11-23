import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { fab_package_check } from "../src/tools/fab-package-check";
import { contextFactory, mockServices, tempProject } from "./mock-services";
import { completePackage } from "../../fab-check/test/fixtures";

describe("fab_package_check", () => {
  test("exposes the MCP schema", () => {
    expect(fab_package_check.name).toBe("fab_package_check");
    expect(fab_package_check.toolset).toBe("export");
    expect(fab_package_check.inputSchema).toHaveProperty("fab");
    expect(fab_package_check.description).toContain("Gerbers");
  });

  test("writes reports/fab-check/latest.json and layer renders", async () => {
    const project = await tempProject("fab-check");
    const gerbers = join(project.dir, "exports/gerbers");
    await mkdir(gerbers, { recursive: true });
    for (const file of completePackage()) {
      const dest = join(project.dir, "exports", file.name);
      await mkdir(join(dest, ".."), { recursive: true });
      await Bun.write(dest, file.bytes);
    }
    const services = mockServices([project]);
    const factory = contextFactory(services, project);
    const reg = createRegistry();
    const out = await reg.invoke("fab_package_check", { fab: "generic" }, (ref) =>
      factory({
        def: reg.get("fab_package_check")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    expect(out.json).toMatchObject({ version: 1 });
    expect(out.text).toContain("Fab package check:");
    expect(await Bun.file(join(project.dir, "reports/fab-check/latest.json")).exists()).toBe(true);
    const report = (await Bun.file(join(project.dir, "reports/fab-check/latest.json")).json()) as {
      checks: Array<{ id: string }>;
      renders: Array<{ pngPath: string }>;
    };
    expect(report.checks.map((c) => c.id)).toContain("completeness");
    expect(report.renders.length).toBeGreaterThan(0);
    expect(out.images?.length).toBeGreaterThan(0);
  });
});
