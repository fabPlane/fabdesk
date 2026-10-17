import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

for (const mode of ["always", "never", "onOpen"] as const) {
  test(`public route_run honors ${mode}, pass budget and an explicit narrowing allowance`, async () => {
    const project = await tempProject(`forward-options-${mode}`);
    const board = (width: number) =>
      `(kicad_pcb (net "N1") (segment (start 0 0) (end 1 0) (width ${width}) (layer "F.Cu") (net "N1") (uuid "track")))`;
    await writeFile(join(project.dir, "board.kicad_pcb"), board(0.3));
    await writeFile(join(project.dir, "board.kicad_pro"), "{}");
    const base = mockServices([project]);
    let cleanCount = 0;
    const budgets: number[] = [];
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async (dir, select) =>
          select === "unrouted" ? [{ net: "N1" }] : base.design.query(dir, select),
        unroute: async (_dir, nets) => {
          expect(nets).toEqual(["N1"]);
          cleanCount++;
          return { tracks: 1, vias: 0 };
        },
        route: async (dir, options) => {
          budgets.push(options.freerouting!.passes);
          await writeFile(join(dir, "board.kicad_pcb"), board(0.2));
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
            unrouted: [{ net: "N1", from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }],
            log: [],
          };
        },
      },
    });
    const registry = createRegistry();
    const factory = contextFactory(services, project);
    const response = await registry.invoke(
      "route_run",
      {
        router: "freerouting",
        onlyConnections: ["N1"],
        ...(mode === "onOpen" ? {} : { rerouteMode: mode, freeroutingPasses: 100 }),
        allowQualityRegression: ["narrowing"],
        waitMs: 1000,
      },
      (ref) =>
        factory({
          def: registry.get("route_run")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    const record = services.routeRuns.get((response.json as any).run.id)!;
    expect(budgets).toEqual(mode === "onOpen" ? [100, 100] : [100]);
    expect(cleanCount).toBe(mode === "never" ? 0 : 1);
    expect(record.application.state).toBe("applied");
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(board(0.2));
    const request = JSON.parse(
      await readFile(join(project.dir, record.artifacts.runDir, "request.json"), "utf8"),
    );
    expect(request).toMatchObject({
      rerouteMode: mode,
      freeroutingPasses: 100,
      allowQualityRegression: ["narrowing"],
    });
  });
}
