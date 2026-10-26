import { test, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const segment = (net: string, width: number, length: number, id = net) =>
  `(segment (start 0 0) (end ${length} 0) (width ${width}) (layer "F.Cu") (net "${net}") (uuid "${id}"))`;
for (const scenario of ["width", "skew", "outside", "failure"] as const) {
  test(`quality reports and protects ${scenario} before application`, async () => {
    const project = await tempProject(`harness-${scenario}`);
    const start = `(kicad_pcb (net "D_P") (net "D_N") (net "OTHER") ${segment("D_P", 0.3, 1)} ${segment("D_N", 0.3, 1)} ${segment("OTHER", 0.3, 1)})`;
    await writeFile(join(project.dir, "board.kicad_pcb"), start);
    await writeFile(join(project.dir, "board.kicad_pro"), "{}");
    const base = mockServices([project]);
    let options: any;
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async (dir, select) =>
          select === "unrouted" ? [{ net: "D_P" }, { net: "D_N" }] : base.design.query(dir, select),
        route: async (dir, opts) => {
          options = opts;
          if (scenario === "failure") throw Error("search failed");
          await writeFile(
            join(dir, "board.kicad_pcb"),
            `(kicad_pcb (net "D_P") (net "D_N") (net "OTHER") ${segment("D_P", scenario === "width" ? 0.2 : 0.3, scenario === "skew" ? 3 : 1)} ${segment("D_N", 0.3, 1)} ${segment("OTHER", 0.3, scenario === "outside" ? 2 : 1)})`,
          );
          return {
            tracks: 1,
            vias: 0,
            claimedVias: 0,
            routed: 1,
            total: 2,
            trackLengthNm: 1e6,
            elapsedMs: 1,
            wallMs: 1,
            timedOut: false,
            message: "partial",
            unrouted: [{ net: "D_N", from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }],
            log: [],
          };
        },
      },
    });
    const registry = createRegistry(),
      factory = contextFactory(services, project);
    const call = (name: string, args: any) =>
      registry.invoke(name, args, (ref) =>
        factory({
          def: registry.get(name)!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
      );
    const response = await call("route_run", {
      router: "fab_router",
      onlyConnections: ["D_P", "D_N"],
      waitMs: 1000,
      rules: { widthMm: 0.2, pairs: [{ p: "D_P", n: "D_N" }] },
    });
    const run = services.routeRuns.get((response.json as any).run.id)!;
    expect(response.text).toContain("Opens: 2 →");
    expect(response.text).toContain("D_P");
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(start);
    expect(options.settings.perNet).toContainEqual({ net: "D_P", widthMm: 0.3 });
    if (scenario === "failure") {
      expect(run.application.state).toBe("not_available");
      return;
    }
    if (scenario === "outside") {
      expect(run.application.state).toBe("rejected");
      expect(response.text).toContain("copper outside request");
      return;
    }
    expect(run.application.state).toBe("manual");
    const kind = scenario === "width" ? "narrowing" : "skew";
    expect(run.result!.quality!.warnings!.map((w) => w.kind)).toContain(kind);
    await expect(
      call("route_apply", { runId: run.id, expectedPcbRevision: run.startingPcbRevision }),
    ).rejects.toThrow("allowQualityRegression");
    await call("route_apply", {
      runId: run.id,
      expectedPcbRevision: run.startingPcbRevision,
      allowQualityRegression: [kind],
    });
    expect(services.routeRuns.get(run.id)!.application.state).toBe("applied");
  });
}

test("whole-board routing reports retained widths when no geometry is added", async () => {
  const project = await tempProject("retained-widths");
  await writeFile(
    join(project.dir, "board.kicad_pcb"),
    `(kicad_pcb (net "N1") ${segment("N1", 0.3, 1)})`,
  );
  await writeFile(join(project.dir, "board.kicad_pro"), "{}");
  const base = mockServices([project]);
  const services = mockServices([project], {
    design: {
      ...base.design,
      query: async (dir, select) => (select === "unrouted" ? [] : base.design.query(dir, select)),
      route: async () => ({
        tracks: 0,
        vias: 0,
        claimedVias: 0,
        routed: 0,
        total: 0,
        trackLengthNm: 0,
        elapsedMs: 1,
        wallMs: 1,
        timedOut: false,
        message: "already connected",
        unrouted: [],
        log: [],
      }),
    },
  });
  const registry = createRegistry(),
    factory = contextFactory(services, project);
  const response = await registry.invoke(
    "route_run",
    { router: "freerouting", waitMs: 1000 },
    (ref) =>
      factory({
        def: registry.get("route_run")!,
        projectRef: ref,
        signal: new AbortController().signal,
        progress: () => {},
      }),
  );
  expect(response.text).toContain("N1: minimum width 0.3 → 0.3 mm");
  expect((response.json as any).run.application.state).toBe("applied");
});
