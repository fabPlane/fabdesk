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

    const settings: Partial<RouterSettings> = {
      ...((request.settings ?? {}) as Partial<RouterSettings>),
      maxTotalMs: request.timeoutMs,
    };
    const options: SrjRouteOptions = {
      settings,
      ...(request.onlyConnections !== undefined
        ? { onlyConnections: request.onlyConnections }
        : {}),
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
    for (const diagnosis of routed.openDiagnoses) {
      details.push(`${diagnosis.connection}: ${diagnosis.kind}`);
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
