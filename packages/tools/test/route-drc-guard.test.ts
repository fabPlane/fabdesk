import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRegistry } from "../src";
import { newRoutingDrcErrors } from "../src/routing-drc";
import type { DrcReport, DrcViolation } from "../src/services";
import { contextFactory, mockServices, tempProject } from "./mock-services";

const violation = (rule: string, severity: DrcViolation["severity"] = "error"): DrcViolation => ({
  rule,
  severity,
  description: rule,
  items: [],
  coordinates: [{ x: 1, y: 2 }],
  layers: ["F.Cu"],
  nets: ["N1"],
  objectIds: [rule],
  affectedGeometry: [],
  signature: rule,
});
const report = (violations: DrcViolation[]): DrcReport => ({
  violations,
  unconnected: [],
  schematicParity: [],
  counts: {
    errors: violations.filter((v) => v.severity === "error").length,
    warnings: 0,
    unconnected: 0,
  },
});

test("native DRC occurrence comparison cannot hide a new error behind a removed error", () => {
  expect(
    newRoutingDrcErrors(report([violation("old")]), report([violation("hole_clearance")])),
  ).toEqual([violation("hole_clearance")]);
  expect(
    newRoutingDrcErrors(report([violation("old")]), report([violation("old"), violation("old")])),
  ).toHaveLength(1);
  expect(
    newRoutingDrcErrors(
      report([violation("old")]),
      report([violation("old"), violation("warning", "warning")]),
    ),
  ).toEqual([]);
});

for (const rule of ["track_width", "hole_clearance", null])
  for (const policy of ["auto", "manual"] as const) {
    test(`Freerouting ${policy} candidate ${rule ? `rejects new ${rule}` : "allows unchanged native errors"}`, async () => {
      const project = await tempProject(`fr-drc-${policy}-${rule}`);
      const board = join(project.dir, "board.kicad_pcb");
      const starting = '(kicad_pcb (net "N1"))';
      await writeFile(board, starting);
      await writeFile(join(project.dir, "board.kicad_pro"), "{}");
      const customRules = '(version 1)\n(rule "custom-width" (constraint track_width (min 0.8mm)))\n';
      await writeFile(join(project.dir, "board.kicad_dru"), customRules);
      const base = mockServices([project]);
      let checks = 0;
      const services = mockServices([project], {
        kicad: {
          ...base.kicad,
          runDrc: async (_cli, options) => {
            // Routing changes copper while cached zone fill can still overlap it.
            expect(options.refillZones).toBe(true);
            expect(await readFile(join(options.board, "..", "board.kicad_dru"), "utf8")).toBe(customRules);
            return report([violation("old"), ...(checks++ > 0 && rule ? [violation(rule)] : [])]);
          },
        },
        design: {
          ...base.design,
          route: async (dir) => {
            await writeFile(
              join(dir, "board.kicad_pcb"),
              '(kicad_pcb (net "N1") (segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net "N1") (uuid "new-track")))',
            );
            return {
              tracks: 1,
              vias: 0,
              claimedVias: 0,
              routed: 1,
              total: 1,
              trackLengthNm: 1e6,
              elapsedMs: 1,
              wallMs: 1,
              timedOut: false,
              message: "routed",
              unrouted: [],
              log: [],
              geometry: [
                {
                  kind: "trace",
                  id: "new-track",
                  layer: 3,
                  net: 1,
                  netName: "N1",
                  points: [0, 0, 1, 0],
                  width: 0.2,
                },
              ],
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
        router: "freerouting",
        waitMs: 1000,
        applyPolicy: policy,
      });
      const run = services.routeRuns.get((response.json as any).run.id)!;
      expect(checks).toBe(2);
      expect(run.candidate.available).toBe(true); // Rejected candidate remains reviewable.
      if (rule) {
        expect(run.application.state).toBe("rejected");
        expect(run.error).toContain(rule);
        expect(run.drcErrors).toEqual([violation(rule)]);
        expect(run.artifacts.drcCheck).toContain("routing-drc-check.json");
        expect(await readFile(board, "utf8")).toBe(starting);
        await expect(
          call("route_apply", { runId: run.id, expectedPcbRevision: run.startingPcbRevision }),
        ).rejects.toThrow("native DRC");
      } else expect(run.application.state).toBe(policy === "auto" ? "applied" : "manual");
    });
  }
