/**
 * One bridge session per project, with a typed `@fp-pcb/client` connection over the bridge's
 * WebSocket: `KiCad` for the server, `Board` for the open board. The bridge owns the `kicad-cli
 * api-server` process; this only remembers which session belongs to which project directory and
 * reconnects when the bridge reaped it (404 on the next call).
 *
 * The session is opened on `board.kicad_pcb` when the project has one (that opens the board and
 * its project), on `board.kicad_pro` when only the project exists (the board is then opened
 * explicitly), and bare otherwise — the compile job creates the project on a bare session. So
 * `board()` re-asks KiCad for the current board every time rather than caching what may not
 * exist yet.
 */
import { join } from "node:path";
import { KiCad, type Board, type Schematic } from "@fp-pcb/client";
import { DocumentType } from "@fp-pcb/proto";
import { WebSocketTransport, bridgeWsUrl } from "@fp-pcb/client/transport";
import { ToolError } from "@fabdesk/tools";
import type { FpPcbBridgeClient } from "./fp-pcb-bridge";

export const BOARD_PRO = "board.kicad_pro";
export const BOARD_PCB = "board.kicad_pcb";

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
    private readonly opts: {
      clientName?: string;
      exists?: (path: string) => Promise<boolean>;
      log?: (m: string) => void;
    } = {},
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
    const exists = this.opts.exists ?? ((p: string) => Bun.file(p).exists());
    const board = await this.withRetry(projectDir, async (s) => {
      const open = await s.kicad.currentBoard();
      if (open) return open;
      // A session started on the .kicad_pro (or bare, then given a project) has the project but no
      // board document open yet.
      const pcb = join(projectDir, BOARD_PCB);
      if (s.path && (await exists(pcb))) return s.kicad.openBoard(pcb);
      return null;
    });
    if (!board)
      throw new ToolError(
        "no board is open for this project yet: run circuit_build first",
        "precondition",
      );
    return board;
  }

  /** The project's open schematic, without creating project files as a side effect. */
  async schematic(projectDir: string): Promise<Schematic> {
    const exists = this.opts.exists ?? ((p: string) => Bun.file(p).exists());
    const schematic = await this.withRetry(projectDir, async (s) => {
      const open = await s.kicad.currentSchematic();
      if (open) return open;
      const path = join(projectDir, "board.kicad_sch");
      return (await exists(path)) ? s.kicad.openSchematic(path) : null;
    });
    if (!schematic)
      throw new ToolError(
        "board.kicad_sch not found: start it with schematic_edit or build an existing netlist",
        "precondition",
      );
    return schematic;
  }

  /**
   * Ensure the normal `board.kicad_pro/.kicad_sch/.kicad_pcb` triplet exists and is open in one
   * headless KiCad session. This is the native schematic-first entry point; no netlist is needed.
   */
  async ensureProject(
    projectDir: string,
  ): Promise<{ session: ProjectSession; schematic: Schematic; board: Board }> {
    return this.withRetry(projectDir, async (s) => {
      const exists = this.opts.exists ?? ((p: string) => Bun.file(p).exists());
      const pro = join(projectDir, BOARD_PRO);
      const sch = join(projectDir, "board.kicad_sch");
      const pcb = join(projectDir, BOARD_PCB);
      if (!(await exists(pro))) {
        await s.kicad.newProject(pro);
        s.path = pro;
      }
      await this.bridge().registerBundledLibraries(s.id);
      let schematic = await s.kicad.currentSchematic();
      if (!schematic)
        schematic = (await exists(sch))
          ? await s.kicad.openSchematic(sch)
          : await s.kicad.newDocument(DocumentType.DOCTYPE_SCHEMATIC, sch);
      let board = await s.kicad.currentBoard();
      if (!board)
        board = (await exists(pcb))
          ? await s.kicad.openBoard(pcb)
          : await s.kicad.newDocument(DocumentType.DOCTYPE_PCB, pcb);
      return { session: s, schematic, board };
    });
  }

  /** Runs `fn` on the session, reconnecting once when the bridge no longer knows it. */
  async withRetry<T>(projectDir: string, fn: (s: ProjectSession) => Promise<T>): Promise<T> {
    const s = await this.session(projectDir);
    try {
      return await fn(s);
    } catch (e) {
      if (!isGone(e)) throw e;
      this.opts.log?.(
        `fp-pcb session for ${projectDir} is gone (${e instanceof Error ? e.message : String(e)}); reconnecting`,
      );
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
    const pcb = join(projectDir, BOARD_PCB);
    const path = (await exists(pcb)) ? pcb : (await exists(pro)) ? pro : null;
    const bridge = this.bridge();
    const clientName = this.opts.clientName ?? `fabdesk/core/${process.pid}`;
    const attach = async (id: string): Promise<{ kicad: KiCad; ws: WebSocketTransport }> => {
      const ws = await WebSocketTransport.connect(bridgeWsUrl(bridge.url, id));
      try {
        return { kicad: await KiCad.connect(ws, { clientName }), ws };
      } catch (e) {
        await ws.close().catch(() => undefined);
        throw e;
      }
    };
    // A session the bridge lists under this project's path.
    const sessions = await bridge.sessions();
    const live = (s: { state: string }) => !["failed", "stopped", "exited"].includes(s.state);
    const byPath = path
      ? sessions.find((s) => (s.path === pcb || s.path === pro) && live(s))
      : undefined;
    if (byPath) return { id: byPath.id, ...(await attach(byPath.id)), path };
    // A bare session whose open project is this one: the compile job created the project inside a
    // session the bridge started without a path, and the bridge still lists it as bare.
    if (path) {
      for (const s of sessions.filter((x) => x.path === null && live(x))) {
        const a = await attach(s.id).catch(() => null);
        if (!a) continue;
        const open = await a.kicad
          .projectInfo()
          .then((i) => i.kicadProPath)
          .catch(() => "");
        if (open === pro) {
          this.opts.log?.(`fp-pcb: adopting bare session ${s.id} that holds ${path}`);
          return { id: s.id, ...a, path };
        }
        await a.ws.close().catch(() => undefined);
      }
    }
    const session = await bridge.createSession(path);
    return { id: session.id, ...(await attach(session.id)), path };
  }
}

function isGone(e: unknown): boolean {
  if (e instanceof ToolError) return e.code === "not_found";
  const message = e instanceof Error ? e.message : String(e);
  return /closed|not connected|ECONNRESET|unknown session|server restarted|kicad_token/i.test(
    message,
  );
}
