/**
 * How the administrative subcommands (`devices`, `pair`) reach a running daemon: the handshake
 * file names its loopback port and bearer token, exactly as `fabdesk-core mcp` finds it. They
 * never start a daemon themselves — pairing is only meaningful against the one the desktop (or
 * `serve --remote`) is running.
 */
import type { CoreConfig } from "../config";
import { findLiveDaemon } from "../mcp-stdio";

/** Where command output goes; tests capture it. stdout stays machine-readable, prose goes to stderr. */
export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}
export const stdio: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

export class DaemonHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "DaemonHttpError";
  }
}

export interface DaemonClient {
  baseUrl: string;
  token: string;
  request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T>;
}

export function daemonClient(
  baseUrl: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): DaemonClient {
  return {
    baseUrl,
    token,
    async request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
      const { json, ...rest } = init;
      const res = await fetchImpl(`${baseUrl}${path}`, {
        ...rest,
        headers: {
          authorization: `Bearer ${token}`,
          ...(json !== undefined ? { "content-type": "application/json" } : {}),
          ...((rest.headers as Record<string, string>) ?? {}),
        },
        ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let message = text || `${res.status} ${res.statusText}`;
        try {
          const body = JSON.parse(text) as { error?: unknown };
          if (typeof body.error === "string" && body.error) message = body.error;
        } catch {
          /* not JSON */
        }
        throw new DaemonHttpError(res.status, path, message);
      }
      return (await res.json()) as T;
    },
  };
}

/** The running daemon for `config.home`, or null with the reason written to `io.err`. */
export async function connectToDaemon(config: CoreConfig, io: Io): Promise<DaemonClient | null> {
  const hs = await findLiveDaemon(config.handshakePath);
  if (!hs) {
    io.err(
      `No running fabdesk-core found (looked for ${config.handshakePath}). Start the fabPlane app, or run: fabdesk-core serve --remote\n`,
    );
    return null;
  }
  return daemonClient(`http://${hs.host}:${hs.port}`, hs.token);
}
