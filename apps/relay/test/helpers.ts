import type { DaemonToRelay, RelayToDaemon } from "../src/protocol";
import type { FetchLike, RelayServer } from "../src/server";

export const CORE = "core_abcdefghijkl";
export const API = "https://api.example.test";
export const SESSIONS: Record<string, string> = { "sess-maya": "user_maya", "sess-jo": "user_jo" };

/** Fake `GET /v1/auth/me`: a known bearer maps to a subject, anything else is 401. */
export const makeFakeAuth = (onCall?: (bearer: string | undefined) => void): FetchLike => {
  return async (url, init) => {
    if (url !== `${API}/v1/auth/me`) throw new Error(`unexpected auth url ${url}`);
    const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "");
    onCall?.(bearer);
    const subject = bearer ? SESSIONS[bearer] : undefined;
    if (!subject) return new Response(JSON.stringify({ user: null }), { status: 401 });
    return new Response(JSON.stringify({ user: { subject } }), {
      headers: { "content-type": "application/json" },
    });
  };
};
export const fakeAuth: FetchLike = makeFakeAuth();

export const wsUrl = (relay: RelayServer) => relay.url.replace("http", "ws");

/** A fake daemon: answers `open` frames from a table and echoes `ws-msg`. */
export class FakeDaemon {
  ws!: WebSocket;
  frames: RelayToDaemon[] = [];
  closeCode: number | null = null;
  private closeWaiters: Array<(code: number) => void> = [];
  private waiters: Array<(f: RelayToDaemon) => void> = [];

  constructor(
    readonly relay: RelayServer,
    readonly bearer: string,
    readonly coreId = CORE,
  ) {}

  connect(): Promise<{ ok: boolean; status?: number }> {
    return new Promise((resolve) => {
      this.ws = new WebSocket(`${wsUrl(this.relay)}/d?coreId=${this.coreId}`, {
        headers: { authorization: `Bearer ${this.bearer}` },
      } as never);
      this.ws.onopen = () => resolve({ ok: true });
      this.ws.onerror = () => resolve({ ok: false });
      this.ws.onclose = (ev) => {
        this.closeCode = ev.code;
        for (const w of this.closeWaiters.splice(0)) w(ev.code);
        resolve({ ok: false, status: ev.code });
      };
      this.ws.onmessage = (ev) => {
        const frame = JSON.parse(String(ev.data)) as RelayToDaemon;
        this.frames.push(frame);
        const w = this.waiters.shift();
        if (w) w(frame);
      };
    });
  }

  closed(): Promise<number> {
    if (this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve) => this.closeWaiters.push(resolve));
  }

  next(): Promise<RelayToDaemon> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push((f) => resolve(this.frames.shift() ?? f)));
  }

  send(frame: DaemonToRelay) {
    this.ws.send(JSON.stringify(frame));
  }

  /** Serves one `open` with a canned answer. */
  async answer(status: number, body: unknown, headers: Record<string, string> = {}) {
    const f = await this.next();
    if (f.t !== "open") throw new Error(`expected open, got ${f.t}`);
    this.send({
      t: "resp",
      sid: f.sid,
      status,
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      bodyEncoding: "utf8",
    });
    return f;
  }
}

export const waitForClosed = (ws: WebSocket) =>
  new Promise<number>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) resolve(-1);
    ws.addEventListener("close", (ev) => resolve(ev.code));
  });

/** Opens a phone WebSocket and resolves once it is open (or fails). */
export const openClient = (relay: RelayServer, path = `/c/${CORE}/ws`, auth?: string) =>
  new Promise<{ ws: WebSocket; ok: boolean }>((resolve) => {
    const ws = new WebSocket(
      `${wsUrl(relay)}${path}`,
      auth ? ({ headers: { authorization: auth } } as never) : undefined,
    );
    ws.onopen = () => resolve({ ws, ok: true });
    ws.onerror = () => resolve({ ws, ok: false });
    ws.onclose = () => resolve({ ws, ok: false });
  });

export const until = async (cond: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
};
