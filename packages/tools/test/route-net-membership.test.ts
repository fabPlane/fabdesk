import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

// Exercise the route worker's inventory guard and automatic application, rather than a copy
// of its comparator. The bridge rows deliberately vary net codes/declarations independently.
async function routeWithRows(after: Record<string, Array<Record<string, unknown>>>) {
  const project = await tempProject("route-net-membership");
  const boardPath = join(project.dir, "board.kicad_pcb");
  await writeFile(boardPath, "legacy-net-table");
  await writeFile(join(project.dir, "board.kicad_pro"), "{}");
  const before = {
    nets: [
      { name: "GND", code: 1, pads: 1 },
      { name: "SIGNAL", code: 2, pads: 1 },
    ],
    pads: [
      { id: "pad-a", component: "R1", number: "1", net: "GND" },
      { id: "pad-b", component: "R1", number: "2", net: "SIGNAL" },
    ],
    tracks: [{ id: "track-a", net: "COPPER_ONLY" }],
    vias: [{ id: "via-a", net: "VIA_ONLY" }],
    zones: [{ id: "zone-a", net: "ZONE_ONLY" }],
  };
  const base = mockServices([project]);
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) => {
        const candidate =
          (await readFile(join(dir, "board.kicad_pcb"), "utf8")) === "inline-net-names";
        const rows: Record<string, Array<Record<string, unknown>>> = candidate
          ? { ...before, ...after }
          : before;
        return rows[select] ?? [];
      },
      route: async (dir, opts, hooks) => {
        const result = await base.design.route(dir, opts, hooks);
        await writeFile(join(dir, "board.kicad_pcb"), "inline-net-names");
        return result;
      },
    },
  });
  const registry = createRegistry();
  const factory = contextFactory(services, project);
  const response = await registry.invoke(
    "route_run",
    { applyPolicy: "auto", waitMs: 5000 },
    (ref) =>
      factory({
        def: registry.get("route_run")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
  );
  const run = (
    response.json as {
      run: { state: string; application: { state: string }; error: string | null };
    }
  ).run;
  return { run, bytes: await readFile(boardPath, "utf8") };
}

test("legacy declarations removed and codes renumbered with identical assignments are accepted", async () => {
  const { run, bytes } = await routeWithRows({ nets: [] });
  expect(run.state).toBe("completed");
  expect(run.application.state).toBe("applied");
  expect(bytes).toBe("inline-net-names");
  expect((await routeWithRows({ nets: [{ name: "GND", code: 99, pads: 1 }] })).run.state).toBe(
    "completed",
  );
});

test("pad reassignment is rejected even when the assigned name set is unchanged", async () => {
  const { run, bytes } = await routeWithRows({
    pads: [
      { id: "pad-a", component: "R1", number: "1", net: "SIGNAL" },
      { id: "pad-b", component: "R1", number: "2", net: "GND" },
    ],
  });
  expect(run.error).toContain("nets");
  expect(run.application.state).toBe("rejected");
  expect(bytes).toBe("legacy-net-table");
});

for (const select of ["tracks", "vias"] as const) {
  test(`${select}: removing an assigned net is rejected`, async () => {
    expect((await routeWithRows({ [select]: [] })).run.error).toContain("nets");
  });
  test(`${select}: adding an assigned net is rejected`, async () => {
    expect(
      (await routeWithRows({ [select]: [{ id: "new", net: "NEW_NET" }] })).run.error,
    ).toContain("nets");
  });
}

test("unassigning a pad is rejected", async () => {
  expect(
    (
      await routeWithRows({
        pads: [
          { id: "pad-a", component: "R1", number: "1", net: "" },
          { id: "pad-b", component: "R1", number: "2", net: "SIGNAL" },
        ],
      })
    ).run.error,
  ).toContain("nets");
});

test("generated pad UUID changes preserve physical assignments", async () => {
  expect(
    (
      await routeWithRows({
        pads: [
          { id: "regenerated-a", component: "R1", number: "1", net: "GND" },
          { id: "regenerated-b", component: "R1", number: "2", net: "SIGNAL" },
        ],
      })
    ).run.application.state,
  ).toBe("applied");
});
