import { expect, test } from "bun:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

test("SPICE tools persist artifacts while keeping canonical files unchanged", async () => {
  const project = await tempProject("tool-effects");
  const schematic = join(project.dir, "board.kicad_sch");
  await writeFile(schematic, "canonical schematic\n");
  const base = mockServices([project]);
  const services = mockServices([project], {
    kicad: {
      ...base.kicad,
      exportNetlist: async (_cli, { output }) => {
        await writeFile(output, "* controlled SPICE netlist\n.end\n");
        return { paths: [output] };
      },
    },
  });
  const registry = createRegistry();
  const factory = contextFactory(services, project);
  for (const name of ["sim_spice_netlist", "sim_run"]) {
    await registry.invoke(name, {}, (ref) =>
      factory({
        def: registry.get(name)!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    expect(registry.get(name)!.annotations.readOnlyHint).toBe(false);
    expect(registry.get(name)!.annotations.destructiveHint).toBe(true);
    expect(registry.get(name)!.annotations.openWorldHint).toBe(false);
    expect(await readFile(schematic, "utf8")).toBe("canonical schematic\n");
  }
  expect(await readFile(join(project.dir, "exports/circuit.cir"), "utf8")).toContain(
    "controlled SPICE netlist",
  );
  expect(JSON.parse(await readFile(join(project.dir, "reports/spice.json"), "utf8"))).toMatchObject(
    { analysis: "op", engine: "spicey" },
  );
});

test("repeating route_run creates separate durable jobs and is not idempotent", async () => {
  const project = await tempProject("route-effects");
  await writeFile(join(project.dir, "board.kicad_pcb"), "canonical board\n");
  let queued = 0;
  const base = mockServices([project]);
  const services = mockServices([project], {
    routeTasks: {
      ...base.routeTasks,
      enqueue: () => {
        queued++;
        return "queued";
      },
    },
  });
  const registry = createRegistry();
  const factory = contextFactory(services, project);
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const output = await registry.invoke("route_run", { applyPolicy: "manual", waitMs: 0 }, (ref) =>
      factory({
        def: registry.get("route_run")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
    );
    ids.push((output.json as { runId: string }).runId);
  }
  expect(new Set(ids).size).toBe(2);
  expect(queued).toBe(2);
  expect(await readdir(join(project.dir, ".fabdesk/runs"))).toHaveLength(2);
  expect(registry.get("route_run")!.annotations.idempotentHint).toBe(false);
  expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe("canonical board\n");
});
