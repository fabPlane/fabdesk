import { test, expect } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { preferCandidate } from "../src/routing-choice";
import { createRegistry } from "../src";
import { contextFactory, mockServices, tempProject } from "./mock-services";

test("candidate selection puts native safety first, then opens, skew, vias and length", () => {
  const before = { opens: 2, newErrors: 0, outsideScope: 0, skewMm: 1, vias: 2, lengthMm: 10 };
  expect(preferCandidate(before, { ...before, opens: 1 })).toBe(true);
  expect(preferCandidate(before, { ...before, opens: 0, newErrors: 1 })).toBe(false);
  expect(preferCandidate(before, { ...before, opens: 0, outsideScope: 1 })).toBe(false);
  expect(preferCandidate(before, { ...before, skewMm: 2, vias: 0 })).toBe(false);
  expect(preferCandidate(before, { ...before, lengthMm: 9 })).toBe(true);
});
for (const result of ["better", "worse", "unsafe", "failure"] as const)
  test(`one scoped clean attempt keeps ${result} result correctly`, async () => {
    const project = await tempProject(`clean-${result}`);
    const board = (width: number) =>
      `(kicad_pcb (net "N1") (net "OTHER") (segment (start 0 0) (end 1 0) (width 0.3) (layer "F.Cu") (net "N1") (uuid "scope")) (segment (start 0 1) (end 1 1) (width ${width}) (layer "F.Cu") (net "OTHER") (uuid "protected")))`;
    await writeFile(join(project.dir, "board.kicad_pcb"), board(0.3));
    await writeFile(join(project.dir, "board.kicad_pro"), "{}");
    const base = mockServices([project]);
    let calls = 0;
    const scopes: string[][] = [];
    const services = mockServices([project], {
      design: {
        ...base.design,
        query: async (dir, select) =>
          select === "unrouted" ? [{ net: "N1" }] : base.design.query(dir, select),
        unroute: async (dir, nets) => {
          scopes.push(nets!);
          expect(await readFile(join(dir, "board.kicad_pcb"), "utf8")).toBe(board(0.3));
          return { tracks: 1, vias: 0 };
        },
        route: async (dir) => {
          calls++;
          if (calls === 2 && result === "failure") throw Error("retry search failed");
          const opens = calls === 1 ? 1 : result === "worse" ? 2 : 0;
          await writeFile(
            join(dir, "board.kicad_pcb"),
            board(calls === 2 && result === "unsafe" ? 0.2 : 0.3),
          );
          return {
            tracks: 1,
            vias: 0,
            claimedVias: 0,
            routed: 2 - opens,
            total: 2,
            trackLengthNm: 1e6,
            elapsedMs: 1,
            wallMs: 1,
            timedOut: false,
            message: `attempt ${calls}`,
            unrouted: Array.from({ length: opens }, () => ({
              net: "N1",
              from: { x: 0, y: 0 },
              to: { x: 1, y: 0 },
            })),
            log: [],
          };
        },
      },
    });
    const registry = createRegistry(),
      factory = contextFactory(services, project);
    const response = await registry.invoke(
      "route_run",
      { router: "freerouting", onlyConnections: ["N1"], waitMs: 1000 },
      (ref) =>
        factory({
          def: registry.get("route_run")!,
          projectRef: ref,
          signal: new AbortController().signal,
          progress: () => {},
        }),
    );
    const run = services.routeRuns.get((response.json as any).run.id)!;
    expect(calls).toBe(2);
    expect(scopes).toEqual([["N1"]]);
    expect(run.result!.open).toEqual(result === "better" ? [] : ["N1"]);
    const trials = JSON.parse(
      await readFile(join(project.dir, run.artifacts.runDir, "retry.json"), "utf8"),
    );
    expect(trials[1].selected).toBe(result === "better");
    expect(await readFile(join(project.dir, "board.kicad_pcb"), "utf8")).toBe(board(0.3));
  });
