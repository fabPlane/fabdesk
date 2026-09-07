/**
 * One bridge session per project, with a typed `@fp-pcb/client` connection over the bridge's
 * WebSocket: `KiCad` for the server, `Board` for the open board. The bridge owns the `kicad-cli
 * api-server` process; this only remembers which session belongs to which project directory and
 * reconnects when the bridge reaped it (404 on the next call).
 *
 * The session is opened on `board.kicad_pro` when the project has one and bare otherwise — the
 * compile job creates the project on a bare session — so `board()` re-asks KiCad for the current
 * board every time rather than caching what may not exist yet.
 */
import { join } from "node:path";
import { KiCad, type Board } from "@fp-pcb/client";
import { WebSocketTransport, bridgeWsUrl } from "@fp-pcb/client/transport";
import { ToolError } from "@fabdesk/tools";
import type { FpPcbBridgeClient } from "./fp-pcb-bridge";

export const BOARD_PRO = "board.kicad_pro";

export interface ProjectSession {
  id: string;
  kicad: KiCad;
  ws: WebSocketTransport;
  /** The `.kicad_pro` the session opened, or null for a bare server. */
  path: string | null;
}

export class FpPcbSessions {
  private readonly open = new Map<string, Promise<ProjectSession>>();

  constructor(
    private readonly bridge: () => FpPcbBridgeClient,
    private readonly opts: { clientName?: string; exists?: (path: string) => Promise<boolean>; log?: (m: string) => void } = {},
  ) {}

  /** The session for `projectDir`, creating or reconnecting it as needed. */
  session(projectDir: string): Promise<ProjectSession> {
    const cached = this.open.get(projectDir);
    if (cached) return cached;
    const pending = this.connect(projectDir).catch((e) => {
      this.open.delete(projectDir);
      throw e;
    });
    this.open.set(projectDir, pending);
    return pending;
  }

  /** The project's open board; `precondition` when the session has none yet (nothing built). */
  async board(projectDir: string): Promise<Board> {
    const s = await this.withRetry(projectDir, async (s) => (await s.kicad.currentBoard()) ?? null);
    if (!s) throw new ToolError("no board is open for this project yet: run circuit_build first", "precondition");
    return s;
  }

  /** Runs `fn` on the session, reconnecting once when the bridge no longer knows it. */
  async withRetry<T>(projectDir: string, fn: (s: ProjectSession) => Promise<T>): Promise<T> {
    const s = await this.session(projectDir);
    try {
      return await fn(s);
    } catch (e) {
      if (!isGone(e)) throw e;
      this.opts.log?.(`fp-pcb session for ${projectDir} is gone (${e instanceof Error ? e.message : String(e)}); reconnecting`);
      await this.release(projectDir);
      return fn(await this.session(projectDir));
    }
  }

  async release(projectDir: string): Promise<void> {
    const pending = this.open.get(projectDir);
    this.open.delete(projectDir);
    if (!pending) return;
    const s = await pending.catch(() => null);
    await s?.ws.close().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    for (const dir of [...this.open.keys()]) await this.release(dir);
  }

  private async connect(projectDir: string): Promise<ProjectSession> {
    const exists = this.opts.exists ?? ((p: string) => Bun.file(p).exists());
    const pro = join(projectDir, BOARD_PRO);
    const path = (await exists(pro)) ? pro : null;
    const bridge = this.bridge();
    const session = await bridge.sessionFor(path);
    const ws = await WebSocketTransport.connect(bridgeWsUrl(bridge.url, session.id));
    const kicad = await KiCad.connect(ws, { clientName: this.opts.clientName ?? `fabdesk/core/${process.pid}` });
    return { id: session.id, kicad, ws, path };
  }
}

function isGone(e: unknown): boolean {
  if (e instanceof ToolError) return e.code === "not_found";
  const message = e instanceof Error ? e.message : String(e);
  return /closed|not connected|ECONNRESET|unknown session|server restarted|kicad_token/i.test(message);
}
