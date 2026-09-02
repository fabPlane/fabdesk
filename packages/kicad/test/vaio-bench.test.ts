/**
 * Real-board import + six-layer routing check on the pinned VAIO CM5 carrier B2.23.
 * Opt-in (`FABDESK_VAIO_BENCH=1`): the board is private and lives in another repository.
 *
 *   FABDESK_VAIO_BENCH=1 FABDESK_CHANNEL=internal bun test packages/kicad/test/vaio-bench.test.ts
 *
 * Without FABDESK_CHANNEL=internal the routing half runs the capacity adapter instead and says so.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectionsForComponents,
  extractSimpleRouteJson,
  unrouteCircuit,
} from "@fabdesk/tscircuit";
import { RouterHost, isInternalChannel } from "@fabdesk/router";
import { importKicadPcb } from "../src/index";
import { fetchVaioBoard, VAIO_B223 } from "../../../scripts/bench/vaio-b223-source";

const ENABLED = process.env["FABDESK_VAIO_BENCH"] === "1";
const ROUTE_TIMEOUT_MS = Number(process.env["FABDESK_VAIO_ROUTE_TIMEOUT_MS"] ?? 90_000);

describe.skipIf(!ENABLED)("VAIO B2.23 (FABDESK_VAIO_BENCH=1)", () => {
  test(
    "verifies the pin, imports six layers with all copper linked, extracts a six-layer SRJ and routes the repair scope",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "fabdesk-vaio-"));
      const board = await fetchVaioBoard(dir);
      expect(board.sha256).toBe(VAIO_B223.pcbSha256);

      const t0 = performance.now();
      const { circuitJson, report } = await importKicadPcb({ pcbPath: board.pcbPath });
      const importMs = Math.round(performance.now() - t0);
      expect(report.failures).toEqual([]);
      expect(report.source.sha256).toBe(VAIO_B223.pcbSha256);
      expect(report.source.netEncoding).toBe("net-by-name");
      expect(report.source.footprintPlacement).toBe("transform");
      expect(report.layers.copperCount).toBe(6);
      expect(report.layers.mapping.map((m) => m.circuitJson)).toEqual([
        "top",
        "inner1",
        "inner2",
        "inner3",
        "inner4",
        "bottom",
      ]);
      expect(report.counts.footprints).toBe(94);
      expect(report.counts.vias).toBe(442);
      expect(report.counts.segments).toBe(4132);
      expect(report.counts.zones).toBe(4);
      expect(report.nets.collisions).toEqual([]);
      expect(report.copper.tracesUnlinked).toBe(0);
      expect(report.copper.viasUnlinked).toBe(0);
      expect(report.copper.poursUnlinked).toBe(0);
      expect(report.unsupported).toEqual([]);
      expect(report.designRules?.traceWidthMm).toBe(0.15);
      // The alias the runbook warns about resolves to one canonical name.
      expect(report.nets.byOriginal["/CM5/DPHY0_P.D0_N"]).toBe("CM5_DPHY0_P_D0_N");

      const scope = connectionsForComponents(circuitJson, [...VAIO_B223.repairRefs]);
      expect(scope.missing).toEqual([]);
      expect(scope.components).toHaveLength(9);
      expect(scope.connections.length).toBeGreaterThan(20);
      expect(scope.excluded.some((e) => e.net === "GND")).toBe(true);

      const input = unrouteCircuit(circuitJson, scope.connections);
      const t1 = performance.now();
      const { srj, copper } = extractSimpleRouteJson(input, {
        minTraceWidth: 0.15,
        rules: { clearanceMm: 0.13, viaDrillMm: 0.3, viaDiameterMm: 0.45 },
      });
      const srjMs = Math.round(performance.now() - t1);
      expect(srj.layerCount).toBe(6);
      expect(srj.layerNames).toEqual(["top", "inner1", "inner2", "inner3", "inner4", "bottom"]);
      expect(copper.pours).toBe(47);
      expect(copper.unowned).toBe(0);
      const layersUsed = new Set(srj.obstacles.flatMap((o) => o.layers));
      for (const l of ["top", "inner1", "inner3", "bottom"]) expect(layersUsed.has(l)).toBe(true);
      // Single-pad nets (the `unconnected_*` NC pins) have nothing to route and get no SRJ connection.
      const names = new Set(srj.connections.map((c) => c.name));
      const routable = scope.connections.filter((name) => names.has(name));
      expect(routable.length).toBeGreaterThanOrEqual(30);
      // No twin: a net-named connection never shares its endpoint set with a trace-named one.
      const keyOf = (c: (typeof srj.connections)[number]) => c.pointsToConnect.map((p) => p.pcb_port_id ?? `${p.x},${p.y}`).sort().join("|");
      const traceKeys = new Set(srj.connections.filter((c) => c.name.startsWith("source_trace_")).map(keyOf));
      for (const c of srj.connections) if (c.name.startsWith("source_net_")) expect(traceKeys.has(keyOf(c))).toBe(false);

      const router = isInternalChannel() ? "freerouting" : "capacity";
      const host = new RouterHost();
      let frames = 0;
      let meta: string[] = [];
      const t2 = performance.now();
      const result = await host.route(
        {
          runId: "vaio-test",
          router,
          srj,
          timeoutMs: ROUTE_TIMEOUT_MS,
          minFrameIntervalMs: 100,
          onlyConnections: scope.connections,
        },
        {
          onMessage: (m) => {
            if (m.kind === "frame") frames += 1;
            if (m.kind === "meta") meta = m.layers;
          },
        },
      );
      host.dispose();
      const routeMs = Math.round(performance.now() - t2);
      expect(meta).toEqual(["top", "inner1", "inner2", "inner3", "inner4", "bottom"]);
      expect(result.router).toBe(router);
      expect(frames).toBeGreaterThan(0);
      expect(result.stats.frames).toBe(frames);
      console.log(
        `[vaio] import ${importMs} ms (convert ${report.timings.convertMs} ms), srj ${srjMs} ms: ${srj.connections.length} connections / ${srj.obstacles.length} obstacles / ${Math.round(JSON.stringify(srj).length / 1024)} KB; ` +
          `${router} repair scope ${routable.length} connections: ${routeMs} ms, ${result.complete.length} complete, ${result.open.length} open, ${result.stats.vias} vias, ${result.stats.segments} segments, ${frames} frames (${result.stats.framesThrottled ?? 0} throttled), timedOut=${result.timedOut}` +
          (result.detail ? `\n[vaio] detail: ${result.detail.slice(0, 600)}` : ""),
      );
    },
    ROUTE_TIMEOUT_MS * 6 + 120_000,
  );
});
