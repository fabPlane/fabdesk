/**
 * The opt-in second listener, for paired phones.
 *
 * The loopback listener keeps its exact behaviour (MCP's rebinding allowlist, the strict WebSocket
 * origin check, the parent watchdog); this one binds a tailnet/LAN address and serves a narrower
 * app — no MCP, no shutdown, no device administration. It can be started and stopped at runtime
 * from Settings, so enabling remote access never restarts the daemon.
 *
 * There is no TLS here on purpose: the intended deployment is a tailnet, which already encrypts.
 * Never expose this port to the open internet — see docs/mobile.md.
 */
import type { Server } from "bun";
import type { Settings } from "@fabdesk/protocol";
import type { EventBus } from "./bus";
import { errMsg, logger } from "./log";

/** Seconds without a frame (or a pong) before a remote WebSocket counts as gone. */
export const REMOTE_IDLE_TIMEOUT_S = 40;

export interface RemoteHandlers {
  fetch: (req: Request, server: Server) => Response | Promise<Response> | undefined;
  websocket: Bun.WebSocketHandler<never>;
}

export interface RemoteListenerOptions {
  emit: EventBus["emit"];
}

export type RemoteState = { enabled: false } | { enabled: true; host: string; port: number };

export class RemoteListener {
  private server: Server | null = null;
  private current: { host: string; port: number } | null = null;
  private handlers: RemoteHandlers | null = null;

  constructor(private readonly opts: RemoteListenerOptions) {}

  /** Hands over the request handlers; they are built after the app, so they arrive separately. */
  attach(handlers: RemoteHandlers): void {
    this.handlers = handlers;
  }

  state(): RemoteState {
    return this.current ? { enabled: true, ...this.current } : { enabled: false };
  }

  /** Brings the listener in line with the setting: starts, stops, or rebinds as needed. */
  apply(remote: Settings["remote"]): RemoteState {
    if (!remote.enabled) {
      this.stop();
      return this.state();
    }
    if (this.current && this.current.host === remote.host && this.current.port === remote.port)
      return this.state();
    this.stop();
    if (!this.handlers) return this.state();
    const { fetch, websocket } = this.handlers;
    try {
      this.server = Bun.serve<never, Record<never, never>>({
        hostname: remote.host,
        port: remote.port,
        // Phones go half-open rather than closing: iOS suspends the app and the socket just
        // stops answering. The Notifier only pushes to devices with no live socket, so a long
        // idle timeout here turns into a run that ends with no notification at all. Bun pings at
        // half this interval; a socket with no pong by the end of it is dropped.
        idleTimeout: REMOTE_IDLE_TIMEOUT_S,
        fetch: fetch as never,
        websocket,
      });
      this.current = { host: remote.host, port: this.server.port ?? remote.port };
      logger.info("remote listener started", this.current);
      this.opts.emit({ topic: "remote.state", ts: Date.now(), enabled: true, ...this.current });
    } catch (e) {
      const error = errMsg(e);
      this.server = null;
      this.current = null;
      logger.warn("remote listener failed to start", {
        host: remote.host,
        port: remote.port,
        error,
      });
      this.opts.emit({ topic: "remote.state", ts: Date.now(), enabled: false, error });
    }
    return this.state();
  }

  stop(): void {
    if (!this.server) return;
    this.server.stop(true);
    this.server = null;
    this.current = null;
    logger.info("remote listener stopped");
    this.opts.emit({ topic: "remote.state", ts: Date.now(), enabled: false });
  }
}
