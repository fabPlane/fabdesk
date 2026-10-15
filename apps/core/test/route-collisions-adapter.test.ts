import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FpPcbRouteSummary } from "@fabdesk/protocol";
import { createRegistry } from "@fabdesk/tools";
import {
  contextFactory,
  mockServices,
  tempProject,
} from "../../../packages/tools/test/mock-services";
import { createFpPcbDesign } from "../src/fp-pcb-design";
import type { FpPcbBridgeClient } from "../src/fp-pcb-bridge";
import type { FpPcbSessions, ProjectSession } from "../src/fp-pcb-session";

for (const router of ["freerouting", "fab_router"] as const) {
  test(`${router}: bridge collisions reach the real adapter, saved result and run/status text`, async () => {
    const project = await tempProject(`adapter-collisions-${router}`);
    try {
      await writeFile(join(project.dir, "board.kicad_pcb"), '(kicad_pcb (net "GND"))');
      await writeFile(join(project.dir, "board.kicad_pro"), "{}");
      const endpointCollisions = {
        text: "Endpoint-track-width probe tested against the board before routing: 1 collision established. This does not establish that every escape is blocked.",
        obstacleSet: "pre-route" as const,
        testedEndpoints: 2,
        unsupported: 0,
        total: 1,
        truncated: false,
        physicalBlockerEstablished: true,
        collisions: [
          {
            endpoint: { uuid: "pad-native", ref: "J1", pin: "1", layer: "F.Cu" },
            blocker: { uuid: "via-native", type: "via" as const, net: "VBUS" },
            requiredClearanceMm: 0.2,
            measuredClearanceMm: 0.1,
            test: "endpoint-track-width" as const,
          },
        ],
      };
      const summary = FpPcbRouteSummary.parse({
        endpointCollisions,
        total: 1,
        unrouted: [{ net: "GND", from: { x: 0, y: 0 }, to: { x: 1_000_000, y: 1_000_000 } }],
      });
      let requestedRouter: string | undefined;
      let saves = 0;
      const bridge = {
        route: async (_id: string, options: { router: string }) => {
          requestedRouter = options.router;
          return { id: "fake-route", state: "done", summary };
        },
      } as unknown as FpPcbBridgeClient;
      const sessions = {
        board: async () => ({
          save: async () => {
            saves++;
          },
        }),
        withRetry: async (_dir: string, run: (session: ProjectSession) => Promise<unknown>) =>
          run({ id: "fake-session" } as ProjectSession),
      } as unknown as FpPcbSessions;
      const adapter = createFpPcbDesign({ bridge: () => bridge, sessions });
      const base = mockServices([project]);
      let toolsSummary: Awaited<ReturnType<typeof adapter.route>> | undefined;
      const services = mockServices([project], {
        design: {
          ...base.design,
          query: async (dir, q) =>
            q === "unrouted" ? [{ net: "GND" }] : base.design.query(dir, q),
          route: async (...args) => {
            toolsSummary = await adapter.route(...args);
            return toolsSummary;
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
      const response = await call("route_run", { router, onlyConnections: ["GND"], waitMs: 1000 });
      const run = (response.json as any).run;
      const status = await call("route_status", { runId: run.id });
      const saved = JSON.parse(
        await readFile(join(project.dir, run.artifacts.runDir, "result.json"), "utf8"),
      );
      expect(requestedRouter).toBe(router === "freerouting" ? "freerouting" : "js");
      expect(saves).toBe(1);
      expect(toolsSummary?.endpointCollisions).toEqual(endpointCollisions);
      expect(toolsSummary?.unrouted[0]?.to).toEqual({ x: 1, y: 1 });
      expect(saved.summary.endpointCollisions).toEqual(endpointCollisions);
      expect(saved.endpointCollisions).toEqual(endpointCollisions);
      expect((response.json as any).run.result.endpointCollisions).toEqual(endpointCollisions);
      expect((status.json as any).run.result.endpointCollisions).toEqual(endpointCollisions);
      expect(response.text).toContain(endpointCollisions.text);
      expect(status.text).toContain(endpointCollisions.text);
    } finally {
      await rm(project.dir, { recursive: true, force: true });
    }
  });
}
