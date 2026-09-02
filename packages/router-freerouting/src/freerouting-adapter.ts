/**
 * The js_autorouter (Freerouting port) adapter. Internal channel only: it reaches the vendored
 * submodule by relative `.ts` imports (the package's exports map blocks deep imports by name),
 * so this module fails to load in a public checkout and `@fabdesk/router`'s registry degrades
 * to `present: false`.
 */
import type {
  CinemaShape,
  RouteProgressEvent,
  RouteRequest,
  RouteResult,
  SimplifiedPcbTrace,
} from "@fabdesk/protocol";
import {
  FREEROUTING_UNITS_PER_MM,
  FrameEmitter,
  throwIfAborted,
  type RouteHooks,
  type RouterAdapter,
  type RouterProbe,
} from "@fabdesk/router";

import {
  routeSimpleRouteJson,
  type SimpleRouteJson as JsSimpleRouteJson,
  type SrjRouteOptions,
  type SrjRouteResult,
} from "../../../vendor/js_autorouter/src/adapters/tscircuit/simple-route-json.ts";
import {
  captureFrame,
  captureMeta,
  captureStatic,
  idWatermarkOf,
  type CinemaShape as JsCinemaShape,
} from "../../../vendor/js_autorouter/src/autoroute/cinema-capture.ts";
import type { RouterSettings } from "../../../vendor/js_autorouter/src/autoroute/maze/router-settings.ts";
import {
  setRouteObserver,
  type RouteProgressEvent as JsRouteProgressEvent,
} from "../../../vendor/js_autorouter/src/autoroute/route-observer.ts";
import type { BasicBoard } from "../../../vendor/js_autorouter/src/board/facade/basic-board.ts";
import vendorPackage from "../../../vendor/js_autorouter/package.json";

/** The SRJ importer's DSN resolution (`SCALE` in simple-route-json.ts): file units per mm. */
const SRJ_DSN_UNITS_PER_MM = 10_000;

export class FreeroutingAdapter implements RouterAdapter {
  readonly id = "freerouting" as const;

  async probe(): Promise<RouterProbe> {
    const version = typeof vendorPackage.version === "string" ? vendorPackage.version : "unknown";
    return {
      id: this.id,
      present: true,
      ready: true,
      version,
      detail: `js_autorouter ${version} (vendor/js_autorouter, in-process, blocking)`,
    };
  }

  /**
   * Blocking: `routeSimpleRouteJson` runs synchronously and only `settings.maxTotalMs` stops it,
   * so `hooks.signal` is honoured before the run, not during it -- cancel through `RouterHost`.
   * The progress observer is process-global; do not run two routes at once in one process.
   */
  async route(request: RouteRequest, hooks: RouteHooks): Promise<RouteResult> {
    throwIfAborted(hooks.signal);
    const started = performance.now();
    const emitter = new FrameEmitter({
      runId: request.runId,
      router: this.id,
      minFrameIntervalMs: request.minFrameIntervalMs,
      post: hooks.onMessage,
    });

    // `settings` carries js_autorouter's RouterSettings plus a few importer/pipeline knobs that
    // are SrjRouteOptions rather than settings; those are lifted out here by name.
    const {
      importExceptions: rawExceptions,
      finish,
      optimize,
      priorityRetries,
      priorityConnections,
      ...routerSettings
    } = (request.settings ?? {}) as Record<string, unknown>;
    const settings: Partial<RouterSettings> = {
      ...(routerSettings as Partial<RouterSettings>),
      maxTotalMs: request.timeoutMs,
    };
    // A bounded repair keeps every other net's copper as obstacles whose owners are not being
    // routed. Read as keepouts, a plane pour over its own tie endpoint is a refusal
    // ("obstacle buries endpoint"); as context nets it is fixed, netted copper -- the reviewed
    // exception the B2.23.1 repair import needed. Whole-board runs keep the strict default.
    const importExceptions = {
      ...(request.onlyConnections !== undefined ? { unmatchedOwnersAreContextNets: true } : {}),
      ...((rawExceptions as Record<string, boolean> | undefined) ?? {}),
    };
    const options: SrjRouteOptions = {
      settings,
      ...(request.onlyConnections !== undefined
        ? { onlyConnections: request.onlyConnections }
        : {}),
      ...(Object.keys(importExceptions).length > 0 ? { importExceptions } : {}),
      ...(typeof finish === "boolean" ? { finish } : {}),
      ...(typeof optimize === "boolean" ? { optimize } : {}),
      ...(typeof priorityRetries === "number" ? { priorityRetries } : {}),
      ...(Array.isArray(priorityConnections) ? { priorityConnections: priorityConnections.map(String) } : {}),
    };

    // A priority retry routes on a FRESH board, so meta/static/watermark follow the board identity.
    let board: BasicBoard | undefined;
    let watermark = 0;
    setRouteObserver((liveBoard, event) => {
      if (liveBoard !== board) {
        board = liveBoard;
        watermark = idWatermarkOf(liveBoard);
        const meta = captureMeta(liveBoard);
        emitter.meta({
          bounds: meta.bounds,
          layers: [...meta.layers],
          unitsPerMm: FREEROUTING_UNITS_PER_MM,
        });
        emitter.static(convertShapes(captureStatic(liveBoard).shapes));
      }
      const current = liveBoard;
      const mark = watermark;
      emitter.frame(convertEvent(event), () =>
        convertShapes(captureFrame(current, mark, 0, event, 0).shapes),
      );
    });

    let routed: SrjRouteResult;
    try {
      routed = routeSimpleRouteJson(toJsSrj(request.srj), options);
    } finally {
      setRouteObserver(undefined);
    }

    // The kept result may be an earlier attempt's board; make sure the last frame shows it.
    if (routed.board !== board) {
      const mark = board === undefined ? 0 : idWatermarkOf(routed.board);
      emitter.frame(
        { kind: "done" },
        convertShapes(
          captureFrame(routed.board, Math.min(mark, watermark), 0, { kind: "done" }, 0).shapes,
        ),
      );
    }

    const traces: SimplifiedPcbTrace[] = routed.traces.map((trace) => ({
      type: "pcb_trace",
      pcb_trace_id: trace.pcb_trace_id,
      connection_name: trace.connection_name,
      route: trace.route.map((el) =>
        el.route_type === "wire"
          ? { route_type: "wire" as const, x: el.x, y: el.y, width: el.width, layer: el.layer }
          : {
              route_type: "via" as const,
              x: el.x,
              y: el.y,
              from_layer: el.from_layer,
              to_layer: el.to_layer,
            },
      ),
    }));

    const details: string[] = [];
    const actualUnitsPerMm = routed.transform.dsnToBoardValue(SRJ_DSN_UNITS_PER_MM);
    if (actualUnitsPerMm !== FREEROUTING_UNITS_PER_MM) {
      details.push(
        `frame scale mismatch: meta said ${FREEROUTING_UNITS_PER_MM} units/mm, run used ${actualUnitsPerMm}`,
      );
    }
    const importReport = routed.importReport as {
      unmatchedOwners?: readonly string[];
      obstaclesBuryingEndpoints?: readonly string[];
    };
    if ((importReport.unmatchedOwners?.length ?? 0) > 0) {
      details.push(
        `${importReport.unmatchedOwners!.length} obstacle owner(s) match no routed connection` +
          (importExceptions.unmatchedOwnersAreContextNets ? " (imported as context nets)" : " (kept as keepouts)"),
      );
    }
    if ((importReport.obstaclesBuryingEndpoints?.length ?? 0) > 0) {
      details.push(`${importReport.obstaclesBuryingEndpoints!.length} obstacle(s) cover an endpoint`);
    }
    if (routed.routerTimedOut) {
      details.push(`timed out (budget ${request.timeoutMs} ms, best partial board kept)`);
    }
    const byKind = new Map<string, number>();
    for (const diagnosis of routed.openDiagnoses) {
      byKind.set(diagnosis.kind, (byKind.get(diagnosis.kind) ?? 0) + 1);
    }
    for (const [kind, count] of byKind) {
      details.push(`${count} open: ${kind}`);
    }
    for (const diagnosis of routed.openDiagnoses.slice(0, 12)) {
      const blockers = (diagnosis.blockers ?? [])
        .slice(0, 4)
        .map((b) => `#${b.itemId}${b.net !== undefined ? `(${b.net})` : ""}`)
        .join(",");
      details.push(
        `${diagnosis.connection}: ${diagnosis.kind}` +
          (diagnosis.insertionFailure !== undefined ? ` [${diagnosis.insertionFailure}]` : "") +
          (blockers !== "" ? ` blockers ${blockers}` : ""),
      );
    }
    const detail = details.join("; ");

    const result: RouteResult = {
      runId: request.runId,
      router: this.id,
      traces,
      complete: [...routed.connectionsComplete],
      open: [...routed.connectionsOpen],
      timedOut: routed.routerTimedOut,
      stats: {
        vias: traces.reduce((n, t) => n + t.route.filter((p) => p.route_type === "via").length, 0),
        segments: traces.reduce(
          (n, t) => n + Math.max(0, t.route.filter((p) => p.route_type === "wire").length - 1),
          0,
        ),
        wallMs: performance.now() - started,
        frames: emitter.framesSent,
        framesThrottled: emitter.framesThrottled,
      },
      ...(detail !== "" ? { detail } : {}),
    };
    emitter.result(result);
    return result;
  }
}

/** The protocol SRJ is loose and mm-based like js_autorouter's; only the endpoint id key differs. */
function toJsSrj(srj: RouteRequest["srj"]): JsSimpleRouteJson {
  return {
    ...srj,
    connections: srj.connections.map((connection) => ({
      ...connection,
      pointsToConnect: connection.pointsToConnect.map((point) => ({
        x: point.x,
        y: point.y,
        layer: point.layer,
        ...(point.pcb_port_id !== undefined ? { pointId: point.pcb_port_id } : {}),
      })),
    })),
  } as unknown as JsSimpleRouteJson;
}

function convertEvent(event: JsRouteProgressEvent): RouteProgressEvent {
  return {
    kind: event.kind,
    ...(event.passNo !== undefined ? { passNo: event.passNo } : {}),
    ...(event.netNumber !== undefined ? { netNumber: event.netNumber } : {}),
    ...(event.status !== undefined ? { status: event.status } : {}),
    ...(event.coupled !== undefined ? { coupled: event.coupled } : {}),
    ...(event.airline !== undefined
      ? {
          airline: {
            from: { x: event.airline.from.x, y: event.airline.from.y },
            to: { x: event.airline.to.x, y: event.airline.to.y },
          },
        }
      : {}),
  };
}

function convertShapes(shapes: readonly JsCinemaShape[]): CinemaShape[] {
  return shapes.map((shape) => ({
    k: shape.k,
    id: shape.id,
    layer: shape.layer,
    net: shape.net,
    pts: [...shape.pts],
    ...(shape.w !== undefined ? { w: shape.w } : {}),
  }));
}
