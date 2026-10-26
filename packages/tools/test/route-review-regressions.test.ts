import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { copperBoard, projectPairs } from "../src/routing-quality";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const segment = (net: string, width: number, length = 1, locked = "") =>
  `(segment ${locked} (start 0 0) (end ${length} 0) (width ${width}) (layer "F.Cu") (net "${net}") (uuid "${net}"))`;
const board = (p: string, n: string, length = 1, locked = "") =>
  `(kicad_pcb (net "${p}") (net "${n}") ${segment(p, 0.25, length, locked)} ${segment(n, 0.3)})`;
const summary = (timedOut = false) => ({
  tracks: 1,
  vias: 0,
  claimedVias: 0,
  routed: 1,
  total: 2,
  trackLengthNm: 1e6,
  elapsedMs: 1,
  wallMs: 1,
  timedOut,
  message: "partial",
  unrouted: [{ net: "D-", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }],
  log: [] as string[],
});
async function invoke(
  project: Awaited<ReturnType<typeof tempProject>>,
  services: ReturnType<typeof mockServices>,
  args: Record<string, unknown>,
) {
  const registry = createRegistry(),
    factory = contextFactory(services, project);
  const response = await registry.invoke(
    "route_run",
    { router: "fab_router", waitMs: 1000, ...args },
    (ref) =>
      factory({
        def: registry.get("route_run")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
  );
  return services.routeRuns.get((response.json as any).run.id)!;
}

for (const assigned of [true, false])
  test(`detected D+/D- with 0.25/0.30 mm copper routes without conflicting pair widths; assigned=${assigned}`, async () => {
    const project = await tempProject(`width-alignment-${assigned}`);
    await writeFile(join(project.dir, "board.kicad_pcb"), board("D+", "D-"));
    await writeFile(
      join(project.dir, "board.kicad_pro"),
      JSON.stringify({
        net_settings: {
          classes: [{ name: "Differential USB", diff_pair_width: 0.25, diff_pair_gap: 0.2 }],
          netclass_assignments: assigned
            ? { "D+": "Differential USB", "D-": "Differential USB" }
            : {},
        },
      }),
    );
    const base = mockServices([project]);
    let routed = false;
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
        route: async (_dir, opts) => {
          const settings = opts.settings as any;
          const pair = settings.differentialPairs[0];
          for (const net of ["D+", "D-"]) {
            const width = settings.perNet.find((r: any) => r.net === net).widthMm;
            if (pair.widthMm !== undefined && width !== pair.widthMm)
              throw Error(`conflicting pair width for ${net}`);
          }
          expect(pair).toEqual(
            assigned ? { p: "D+", n: "D-", widthMm: 0.3, gapMm: 0.2 } : { p: "D+", n: "D-" },
          );
          routed = true;
          return { ...summary(), unrouted: [] };
        },
      },
    });
    const run = await invoke(project, services, {});
    expect(routed).toBe(true);
    expect(run.state).toBe("completed");
    expect(run.application.state).toBe("applied");
  });

test("VBAT+/- names are measured without inheriting Default differential-pair dimensions", async () => {
  const project = await tempProject("battery-pair");
  await writeFile(join(project.dir, "board.kicad_pcb"), '(kicad_pcb (net "VBAT+") (net "VBAT-"))');
  await writeFile(
    join(project.dir, "board.kicad_pro"),
    JSON.stringify({
      net_settings: {
        classes: [{ name: "Default", diff_pair_width: 0.2, diff_pair_gap: 0.15, track_width: 1 }],
      },
    }),
  );
  const definitions = await projectPairs(
    project.dir,
    copperBoard(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")),
  );
  expect(definitions).toEqual([{ p: "VBAT+", n: "VBAT-", source: "identified by name" }]);
  const base = mockServices([project]);
  let options: any;
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
      route: async (_dir, opts) => {
        options = opts;
        return { ...summary(), unrouted: [] };
      },
    },
  });
  const run = await invoke(project, services, {});
  expect(run.state).toBe("completed");
  expect(options.settings.differentialPairs).toEqual([{ p: "VBAT+", n: "VBAT-" }]);
  expect(options.settings.perNet).toBeUndefined();
});

for (const mode of ["onOpen", "always"])
  test(`locked requested copper survives internal clean and skew retries (${mode})`, async () => {
    const project = await tempProject(`locked-${mode}`);
    const start = board("D+", "D-", 1, "(locked yes)");
    await writeFile(join(project.dir, "board.kicad_pcb"), start);
    await writeFile(join(project.dir, "board.kicad_pro"), "{}");
    const base = mockServices([project]);
    let routes = 0,
      unroutes = 0;
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async (dir, select) =>
          select === "unrouted" ? [{ net: "D-" }] : base.design.query(dir, select),
        unroute: async () => {
          unroutes++;
          throw Error("must not discard locked copper");
        },
        route: async (dir) => {
          routes++;
          await writeFile(join(dir, "board.kicad_pcb"), board("D+", "D-", 3, "(locked yes)"));
          return summary();
        },
      },
    });
    const run = await invoke(project, services, {
      onlyConnections: ["D+", "D-"],
      rerouteMode: mode,
      rules: { pairs: [{ p: "D+", n: "D-" }] },
    });
    expect(routes).toBe(1);
    expect(unroutes).toBe(0);
    expect(
      copperBoard(await readFile(join(project.dir, run.candidate.path), "utf8")).copper.find(
        (c) => c.net === "D+",
      )?.locked,
    ).toBe(true);
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(start);
  });

test("a timed-out summary starts neither the clean retry nor the pair-skew loop", async () => {
  const project = await tempProject("timeout-no-retries");
  await writeFile(join(project.dir, "board.kicad_pcb"), board("D+", "D-"));
  await writeFile(join(project.dir, "board.kicad_pro"), "{}");
  const base = mockServices([project]);
  let routes = 0,
    unroutes = 0;
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) =>
        select === "unrouted" ? [{ net: "D-" }] : base.design.query(dir, select),
      unroute: async () => {
        unroutes++;
        return { tracks: 2, vias: 0 };
      },
      route: async (dir) => {
        routes++;
        await writeFile(join(dir, "board.kicad_pcb"), board("D+", "D-", 3));
        return summary(true);
      },
    },
  });
  const run = await invoke(project, services, {
    onlyConnections: ["D+", "D-"],
    rules: { pairs: [{ p: "D+", n: "D-" }] },
  });
  expect(routes).toBe(1);
  expect(unroutes).toBe(0);
  expect(run.state).toBe("timed_out");
});

test("saved copper lock forms distinguish legacy flags and explicit unlocked items", () => {
  const parsed = copperBoard(
    `(kicad_pcb ${segment("legacy", 0.3, 1, "locked")} ${segment("empty", 0.3, 1, "(locked)")} ${segment("yes", 0.3, 1, "(locked yes)")} ${segment("no", 0.3, 1, "(locked no)")})`,
  );
  expect(parsed.copper.map((c) => c.locked)).toEqual([true, true, true, false]);
});
