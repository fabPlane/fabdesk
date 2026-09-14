/**
 * Counters the relay exposes at `/metrics` in the Prometheus text format. Nothing here carries
 * a peer identifier; labels come from fixed vocabularies (direction, rejection reason).
 */
export type Direction = "to_daemon" | "from_daemon" | "to_client" | "from_client";
const DIRECTIONS: Direction[] = ["to_daemon", "from_daemon", "to_client", "from_client"];

/** Live values the server owns; handed in at render time. */
export interface Gauges {
  daemons: number;
  clients: number;
  pending: number;
  authCacheEntries: number;
  shuttingDown: boolean;
}

export class Metrics {
  readonly startedAt: number;
  daemonConnectionsTotal = 0;
  clientSocketsTotal = 0;
  httpRequestsTotal = 0;
  authChecksTotal = 0;
  authCacheHits = 0;
  authCacheMisses = 0;
  idleClosesTotal = 0;
  backpressureClosesTotal = 0;
  private readonly frames = new Map<Direction, number>();
  private readonly bytes = new Map<Direction, number>();
  private readonly rejections = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  frame(direction: Direction, byteLength: number): void {
    this.frames.set(direction, (this.frames.get(direction) ?? 0) + 1);
    this.bytes.set(direction, (this.bytes.get(direction) ?? 0) + byteLength);
  }

  reject(reason: string): void {
    this.rejections.set(reason, (this.rejections.get(reason) ?? 0) + 1);
  }

  rejected(reason: string): number {
    return this.rejections.get(reason) ?? 0;
  }

  uptimeSeconds(): number {
    return Math.floor((this.now() - this.startedAt) / 1000);
  }

  /** Prometheus exposition text (version 0.0.4). */
  render(g: Gauges): string {
    const lines: string[] = [];
    const head = (name: string, type: "counter" | "gauge", help: string) =>
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    const sample = (name: string, value: number, labels?: Record<string, string>) => {
      const l = labels
        ? `{${Object.entries(labels)
            .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
            .join(",")}}`
        : "";
      lines.push(`${name}${l} ${value}`);
    };

    head("relay_uptime_seconds", "gauge", "Seconds since the relay started.");
    sample("relay_uptime_seconds", this.uptimeSeconds());
    head("relay_shutting_down", "gauge", "1 while the relay drains before exit.");
    sample("relay_shutting_down", g.shuttingDown ? 1 : 0);
    head("relay_daemons_connected", "gauge", "Daemon sockets currently registered.");
    sample("relay_daemons_connected", g.daemons);
    head("relay_clients_connected", "gauge", "Proxied phone WebSockets currently open.");
    sample("relay_clients_connected", g.clients);
    head("relay_http_pending", "gauge", "Proxied HTTP requests waiting for a daemon answer.");
    sample("relay_http_pending", g.pending);
    head("relay_auth_cache_entries", "gauge", "Bearer verdicts currently cached.");
    sample("relay_auth_cache_entries", g.authCacheEntries);

    head("relay_daemon_connections_total", "counter", "Daemon sockets accepted since start.");
    sample("relay_daemon_connections_total", this.daemonConnectionsTotal);
    head("relay_client_sockets_total", "counter", "Phone WebSockets accepted since start.");
    sample("relay_client_sockets_total", this.clientSocketsTotal);
    head("relay_http_requests_total", "counter", "HTTP requests handed to a daemon.");
    sample("relay_http_requests_total", this.httpRequestsTotal);
    head("relay_frames_total", "counter", "Frames and proxied messages by direction.");
    for (const d of DIRECTIONS)
      sample("relay_frames_total", this.frames.get(d) ?? 0, { direction: d });
    head("relay_bytes_total", "counter", "Payload bytes by direction.");
    for (const d of DIRECTIONS)
      sample("relay_bytes_total", this.bytes.get(d) ?? 0, { direction: d });
    head("relay_rejections_total", "counter", "Requests and sockets refused, by reason.");
    for (const [reason, n] of [...this.rejections].sort(([a], [b]) => a.localeCompare(b)))
      sample("relay_rejections_total", n, { reason });
    head("relay_auth_checks_total", "counter", "Calls made to the API's /v1/auth/me.");
    sample("relay_auth_checks_total", this.authChecksTotal);
    head("relay_auth_cache_total", "counter", "Bearer lookups by cache outcome.");
    sample("relay_auth_cache_total", this.authCacheHits, { result: "hit" });
    sample("relay_auth_cache_total", this.authCacheMisses, { result: "miss" });
    head("relay_idle_closes_total", "counter", "Sockets closed for not answering pings.");
    sample("relay_idle_closes_total", this.idleClosesTotal);
    head("relay_backpressure_closes_total", "counter", "Phone sockets closed at the buffer cap.");
    sample("relay_backpressure_closes_total", this.backpressureClosesTotal);
    return lines.join("\n") + "\n";
  }
}
