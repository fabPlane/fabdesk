import { test, expect } from "bun:test";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { mockServices, contextFactory, tempProject } from "./mock-services";

for (const declared of [true, false]) {
  test(`selective ${declared ? "declared" : "undeclared"} route ${declared ? "reports anchors outside scope" : "has no extra scope message"}`, async () => {
    const project = await tempProject(`route-scope-${declared}`);
    await writeFile(
      join(project.dir, "board.kicad_pcb"),
      '(kicad_pcb (net "D_P") (net "D_N") (net "GND"))',
    );
    await writeFile(join(project.dir, "board.kicad_pro"), "{}");
    const base = mockServices([project]);
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async (dir, query) =>
          query === "unrouted" ? [{ net: "D_P" }, { net: "D_N" }] : base.design.query(dir, query),
        route: async (dir) => {
          const tracks = ["D_P", "D_N"].map(
            (net, i) =>
              `(segment (start 0 ${i}) (end 1 ${i}) (width 0.15) (layer "F.Cu") (net "${net}") (uuid "track-${i}"))`,
          );
          const anchors = declared
            ? [0, 1, 2].map(
                (i) =>
                  `(via (at ${i} 3) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "GND") (uuid "anchor-${i}"))`,
              )
            : [];
          await writeFile(
            join(dir, "board.kicad_pcb"),
            `(kicad_pcb (net "D_P") (net "D_N") (net "GND") ${[...tracks, ...anchors].join(" ")})`,
          );
          const geometry = [
            ...["D_P", "D_N"].map((netName, i) => ({
              kind: "trace" as const,
              id: `track-${i}`,
              layer: 0,
              net: i + 1,
              netName,
              points: [0, i, 1, i],
              width: 0.15,
            })),
            ...(declared
              ? [0, 1, 2].map((i) => ({
                  kind: "via" as const,
                  id: `anchor-${i}`,
                  layer: -1,
                  net: 3,
                  netName: "GND",
                  points: [i - 0.3, 2.7, i + 0.3, 3.3],
                }))
              : []),
          ];
          return {
            tracks: 2,
            vias: anchors.length,
            claimedVias: 0,
            routed: 2,
            total: 2,
            trackLengthNm: 2000000,
            elapsedMs: 1,
            wallMs: 1,
            timedOut: false,
            message: "route",
            unrouted: [],
            log: [],
            geometry,
          };
        },
      },
    });
    const registry = createRegistry(),
      factory = contextFactory(services, project);
    const call = (name: string, args: Record<string, unknown>) =>
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
      ...(declared
        ? { rules: { pairs: [{ p: "D_P", n: "D_N", widthMm: 0.15, gapMm: 0.25 }] } }
        : {}),
    });
    const id = (response.json as any).run.id;
    const status = await call("route_status", { runId: id });
    const run = services.routeRuns.get(id)!;
    const result = JSON.parse(
      await readFile(join(project.dir, run.artifacts.runDir, "result.json"), "utf8"),
    );
    expect(result.changedGeometry.every((s: any) => s.net > 0 && s.netName)).toBe(true);
    if (declared) {
      const changes = [{ net: "GND", traces: 0, vias: 3 }];
      expect(result.outsideScopeChanges).toEqual(changes);
      expect((response.json as any).run.result.outsideScopeChanges).toEqual(changes);
      expect((status.json as any).run.result.outsideScopeChanges).toEqual(changes);
      expect(response.text).toContain("Also changed outside scope: GND (3 vias).");
      expect(status.text).toContain("Also changed outside scope: GND (3 vias).");
    } else {
      expect(result.outsideScopeChanges).toBeUndefined();
      expect((status.json as any).run.result.outsideScopeChanges).toBeUndefined();
      expect(response.text).not.toContain("Also changed outside scope");
      expect(status.text).not.toContain("Also changed outside scope");
    }
  });
}
