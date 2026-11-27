/**
 * Wi-Fi (network) link for the fabPlane USB laser driver.
 *
 * The laser's USB cable goes into a small computer next to it (a Raspberry Pi, a mini PC or a laptop) that
 * runs the bridge (`bun packages/laser-cell/src/lmc/bridge-cli.ts`). fabPlane connects to the bridge over
 * the network and the bridge passes the same 12-byte commands and 3072-byte list packets to the USB board.
 *
 * Wire format (TCP), every frame: type (1 byte ASCII) + payload length (uint32 LE) + payload.
 * Every client request gets exactly one answer, so replies can never get out of step:
 *   bridge → client  H  hello, JSON { bridge: "fabplane-lmc", version: 2 }
 *   client → bridge  A  auth, JSON { token }               → K (JSON { device }) or E, then close
 *   client → bridge  W  write a 12- or 3072-byte packet    → O (written) or E
 *   client → bridge  R  read the board's 8-byte reply      → D (8 bytes) or E
 *   client → bridge  C  write a 12-byte command and read   → D (8 bytes) or E   (one round trip)
 *   client → bridge  P  ping                               → O
 * Job mode (hello says `jobs: true`): the bridge runs the whole job itself, so the board is fed over its own
 * USB cable and a Wi-Fi hiccup never starves it; Wi-Fi carries only the job (a few kB) and status:
 *   client → bridge  J  JSON { op: "mark" | "frame", job, options, seconds?, timeoutMs? } → O (started) or E
 *   client → bridge  Q  status                             → D JSON { phase, error, progress, paused }
 *   client → bridge  S  stop the job and halt the board    → O
 *   client → bridge  U / V  pause / resume the job         → O or E
 * Safety:
 * - an access key is required (anyone who can reach the bridge could otherwise fire the laser);
 * - one computer drives the laser at a time. fabPlane pings every PING_MS; a driving computer silent for
 *   SILENT_MS (off the Wi-Fi, crashed) is dropped, and only then can another computer connect;
 * - when the driving computer disconnects or is dropped, its queued requests are skipped, a job running on
 *   the bridge is stopped and the board is halted with its outputs off.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "bun";
import { z } from "zod/v4";
import { LmcJobFileSchema } from "./job-file";
import { LmcLaser, type LmcOptions } from "./laser";
import { Cmd, COMMAND_BYTES, LIST_PACKET_BYTES, command } from "./protocol";
import { LmcUsbError, type LmcTransport } from "./usb";

export const BRIDGE_DEFAULT_PORT = 5021;
export const BRIDGE_VERSION = 2;
/** Large enough for a job in job mode (polygons as JSON); list packets are 3 kB. */
const MAX_FRAME = 64 * 1024 * 1024;

/** What a client may set for a job the bridge runs (everything else is the bridge's own). */
const JobOptionsSchema = z.object({
  field: z.object({
    sizeMm: z.number().min(10).max(600),
    centerMm: z.tuple([z.number().min(-300).max(300), z.number().min(-300).max(300)]),
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    swapXY: z.boolean().optional(),
  }),
  source: z.enum(["co2", "fiber"]),
  pins: z.object({ laser: z.number().int().min(0).max(15), light: z.number().int().min(0).max(15) }),
  maxPowerPct: z.number().min(0).max(100),
  initBoard: z.boolean(),
  frameSeconds: z.number().min(0).max(600),
});
const JobRequestSchema = z.object({
  op: z.enum(["mark", "frame"]),
  job: LmcJobFileSchema,
  options: JobOptionsSchema,
  seconds: z.number().min(0).max(600).optional(),
  timeoutMs: z.number().min(1000).max(48 * 3600_000).optional(),
});
export type BridgeJobOptions = z.infer<typeof JobOptionsSchema>;
export type BridgeJobStatus = { phase: "idle" | "running" | "done" | "error"; error: string | null; progress: { fraction: number; remainingSeconds: number; paused: boolean } | null; paused: boolean };
/**
 * fabPlane pings the bridge every PING_MS while connected. A driving computer silent for longer than
 * SILENT_MS (laptop off the Wi-Fi, crashed) has its link closed and the board stopped; only then can another
 * computer take over. A computer that is merely busy (arm moving between marks) keeps pinging.
 */
export const PING_MS = 2_000;
export const SILENT_MS = 8_000;

export function newBridgeToken(): string {
  return randomBytes(12).toString("base64url");
}

export function frame(type: string, payload: Uint8Array | string = new Uint8Array()): Uint8Array {
  const body = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const out = new Uint8Array(5 + body.length);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setUint32(1, body.length, true);
  out.set(body, 5);
  return out;
}

/** Splits a byte stream into frames. */
export class FrameReader {
  private buf = new Uint8Array(0);
  /** Largest frame accepted; the bridge keeps it small until a client has given the access key. */
  constructor(public maxFrame = MAX_FRAME) {}
  push(chunk: Uint8Array): Array<{ type: string; payload: Uint8Array }> {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out: Array<{ type: string; payload: Uint8Array }> = [];
    while (this.buf.length >= 5) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(1, true);
      if (len > this.maxFrame) throw new LmcUsbError(`bridge frame of ${len} bytes is too large`);
      if (this.buf.length < 5 + len) break;
      out.push({ type: String.fromCharCode(this.buf[0]!), payload: this.buf.slice(5, 5 + len) });
      this.buf = this.buf.slice(5 + len);
    }
    return out;
  }
}

const sameToken = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- bridge (next to the laser)

export type BridgeOptions = {
  port?: number;
  hostname?: string;
  token: string;
  /** Opens the USB board (WinUSB on Windows, usbfs on Linux, or a mock in tests). */
  open: () => Promise<LmcTransport>;
  log?: (line: string) => void;
  /** Override SILENT_MS (tests). */
  silentMs?: number;
};

type Session = { reader: FrameReader; authed: boolean; closed: boolean; lastSeen: number };

/** Starts the bridge. One client at a time drives the board; the USB link is opened on first use. */
export async function startLmcBridge(options: BridgeOptions) {
  const log = options.log ?? (() => undefined);
  const silentMs = options.silentMs ?? SILENT_MS;
  let usb: LmcTransport | null = null;
  let owner: Socket<Session> | null = null;
  /** All USB access goes through this one queue, whichever session asks. */
  let usbQueue: Promise<unknown> = Promise.resolve();
  const onUsb = <T>(fn: (t: LmcTransport) => Promise<T>): Promise<T> => {
    const go = async () => {
      usb ??= await options.open();
      try {
        return await fn(usb);
      } catch (error) {
        const broken = usb;
        usb = null;
        await broken?.close().catch(() => undefined);
        throw error;
      }
    };
    const next = usbQueue.then(go, go);
    usbQueue = next.catch(() => undefined);
    return next;
  };
  /** Board stopped and outputs off, after a driving computer has gone. */
  const stopBoard = (why: string) => onUsb(async t => {
    for (const c of [command(Cmd.StopExecute), command(Cmd.ResetList), command(Cmd.WritePort, 0)]) { await t.write(c); await t.read(); }
  }).then(() => log(`laser stopped: ${why}`), e => log(`could not stop the laser after ${why}: ${e instanceof Error ? e.message : String(e)}`));

  // Job mode: one driver on the bridge, talking to the board through the shared USB queue.
  const usbProxy: LmcTransport = {
    write: p => onUsb(t => t.write(p)),
    read: () => onUsb(t => t.read()),
    transact: p => onUsb(async t => { await t.write(p); return t.read(); }),
    async close() { /* the bridge owns the USB link */ },
  };
  let local: { laser: LmcLaser; key: string } | null = null;
  let job: { phase: BridgeJobStatus["phase"]; error: string | null } = { phase: "idle", error: null };
  const jobStatus = (): BridgeJobStatus => ({ ...job, progress: local?.laser.progress() ?? null, paused: local?.laser.isPaused ?? false });
  const startJob = (raw: unknown) => {
    if (job.phase === "running") throw new LmcUsbError("a job is already running on the bridge; stop it first");
    const parsed = JobRequestSchema.safeParse(raw);
    if (!parsed.success) throw new LmcUsbError(`bad job request (${parsed.error.issues[0]?.path.join(".") ?? ""}: ${parsed.error.issues[0]?.message ?? "invalid"})`);
    const { op, job: lmcJob, options: o, seconds, timeoutMs } = parsed.data;
    const key = JSON.stringify(o);
    if (!local || local.key !== key) {
      const opts: LmcOptions = { field: { sizeMm: o.field.sizeMm, centerMm: o.field.centerMm, ...(o.field.flipX !== undefined ? { flipX: o.field.flipX } : {}), ...(o.field.flipY !== undefined ? { flipY: o.field.flipY } : {}), ...(o.field.swapXY !== undefined ? { swapXY: o.field.swapXY } : {}) }, source: o.source, pins: o.pins, maxPowerPct: o.maxPowerPct, initBoard: o.initBoard, frameSeconds: o.frameSeconds, link: "USB (on the bridge)" };
      local = { laser: new LmcLaser(async () => usbProxy, opts), key };
    }
    const laser = local.laser;
    laser.useJob(lmcJob);
    job = { phase: "running", error: null };
    const current = job;
    const work = op === "mark"
      ? laser.start().then(() => laser.waitDone({ timeoutMs: timeoutMs ?? 24 * 3600_000 }))
      : laser.frame(seconds ?? o.frameSeconds);
    work.then(
      () => { if (job === current) job = { phase: "done", error: null }; log(`job finished (${op})`); },
      e => { if (job === current) job = { phase: "error", error: e instanceof Error ? e.message : String(e) }; log(`job ended: ${e instanceof Error ? e.message : String(e)}`); },
    );
    log(`job started (${op}): ${lmcJob.boardMm.width.toFixed(1)} × ${lmcJob.boardMm.height.toFixed(1)} mm`);
  };
  const stopJob = async () => {
    if (job.phase === "running") job = { phase: "error", error: "stopped" };
    await local?.laser.stop();
  };

  /** Clean-up after a driving computer went away; a new job waits for it. */
  let cleanup: Promise<unknown> = Promise.resolve();
  const release = (s: Socket<Session>, why: string) => {
    s.data.closed = true;
    if (owner !== s) return;
    owner = null;
    log(`${why}: ${s.remoteAddress}`);
    cleanup = cleanup.then(() => stopJob().finally(() => stopBoard(why))).catch(() => undefined);
  };

  const server = Bun.listen<Session>({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? BRIDGE_DEFAULT_PORT,
    socket: {
      open(s) {
        s.data = { reader: new FrameReader(4096), authed: false, closed: false, lastSeen: Date.now() };
        (s as unknown as { setKeepAlive?: (on: boolean, ms: number) => void }).setKeepAlive?.(true, 5000);
        s.write(frame("H", JSON.stringify({ bridge: "fabplane-lmc", version: BRIDGE_VERSION, jobs: true })));
      },
      data(s, chunk) {
        let frames;
        try { frames = s.data.reader.push(new Uint8Array(chunk)); } catch { s.end(); return; }
        s.data.lastSeen = Date.now();
        for (const f of frames) {
          if (!s.data.authed) {
            let token = "";
            try { token = String((JSON.parse(new TextDecoder().decode(f.payload)) as { token?: unknown }).token ?? ""); } catch { /* bad auth */ }
            if (f.type !== "A" || !sameToken(token, options.token)) { log(`refused ${s.remoteAddress}: wrong access key`); s.write(frame("E", "wrong access key")); s.end(); return; }
            if (owner && owner !== s) { s.write(frame("E", "another computer is already driving this laser")); s.end(); return; }
            s.data.authed = true;
            s.data.reader.maxFrame = MAX_FRAME; // jobs may now be sent
            owner = s;
            log(`connected: ${s.remoteAddress}`);
            s.write(frame("K", JSON.stringify({ device: "9588:9899" })));
            continue;
          }
          if (f.type === "P") { s.write(frame("O")); continue; }
          if ("JQSUV".includes(f.type)) {
            if (owner !== s) { s.write(frame("E", "this computer is no longer driving the laser")); continue; }
            const reply = async (): Promise<Uint8Array> => {
              if (f.type === "J") { await cleanup; startJob(JSON.parse(new TextDecoder().decode(f.payload))); return frame("O"); }
              if (f.type === "Q") return frame("D", JSON.stringify(jobStatus()));
              if (f.type === "S") { await stopJob(); return frame("O"); }
              if (!local || job.phase !== "running") throw new LmcUsbError("no job is running on the bridge");
              if (f.type === "U") await local.laser.pause(); else await local.laser.resume();
              return frame("O");
            };
            reply().then(r => { if (!s.data.closed) s.write(r); }, e => { if (!s.data.closed) s.write(frame("E", e instanceof Error ? e.message : String(e))); });
            continue;
          }
          // Queued on the shared USB queue; skipped once this computer is gone or replaced.
          void onUsb(async t => {
            if (s.data.closed || owner !== s) return null;
            if (f.type === "W") {
              if (f.payload.length !== COMMAND_BYTES && f.payload.length !== LIST_PACKET_BYTES) throw new LmcUsbError(`bad packet size ${f.payload.length}`);
              await t.write(f.payload);
              return frame("O");
            }
            if (f.type === "R") return frame("D", await t.read());
            if (f.type === "C") {
              if (f.payload.length !== COMMAND_BYTES) throw new LmcUsbError(`bad command size ${f.payload.length}`);
              await t.write(f.payload);
              return frame("D", await t.read());
            }
            throw new LmcUsbError(`unknown request ${f.type}`);
          }).then(
            reply => { if (reply && !s.data.closed) s.write(reply); },
            error => { if (!s.data.closed) s.write(frame("E", error instanceof Error ? error.message : String(error))); },
          );
        }
      },
      close(s) {
        release(s, "disconnected");
      },
    },
  });
  // Watchdog: a driving computer that went silent (no ping, no request) is dropped and the board stopped.
  const watchdog = setInterval(() => {
    const s = owner;
    if (s && Date.now() - s.data.lastSeen > silentMs) {
      release(s, "the driving computer went silent");
      s.end();
    }
  }, Math.max(20, Math.min(1000, silentMs / 4)));
  (watchdog as unknown as { unref?: () => void }).unref?.();
  return {
    port: server.port,
    async stop() {
      clearInterval(watchdog);
      server.stop(true);
      await stopJob().catch(() => undefined);
      await usbQueue;
      await usb?.close().catch(() => undefined);
      usb = null;
    },
  };
}

// ---------------------------------------------------------------- client (fabPlane)

/**
 * fabPlane's side: an LmcTransport that talks to a bridge over TCP. Every request waits for its own answer;
 * after any error or timeout the link is closed (the driver reconnects), so a late answer is never taken
 * for the answer to a later request.
 */
export async function openBridgeLmc(host: string, port: number, token: string, timeoutMs = 3000, pingMs = PING_MS): Promise<LmcTransport> {
  const reader = new FrameReader();
  let waiter: ((f: { type: string; payload: Uint8Array } | Error) => void) | null = null;
  const early: Array<{ type: string; payload: Uint8Array }> = [];
  let closed = false;
  let socketRef: { end(): void } | null = null;
  const fail = (e: Error) => { closed = true; socketRef?.end(); const w = waiter; waiter = null; w?.(e); };
  const answer = (ms: number) => new Promise<{ type: string; payload: Uint8Array }>((resolve, reject) => {
    const queued = early.shift();
    if (queued) return resolve(queued);
    if (closed) return reject(new LmcUsbError("the laser bridge connection is closed"));
    const timer = setTimeout(() => { waiter = null; fail(new LmcUsbError(`the laser bridge at ${host}:${port} did not answer in time`)); reject(new LmcUsbError(`the laser bridge at ${host}:${port} did not answer in time`)); }, ms);
    waiter = f => { clearTimeout(timer); f instanceof Error ? reject(f) : resolve(f); };
  });
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  const connectTimeout = new Promise<never>((_, reject) => { connectTimer = setTimeout(() => reject(new LmcUsbError(`could not reach the laser bridge at ${host}:${port} within ${Math.round(timeoutMs / 1000)} s; is the bridge running and on the same Wi-Fi?`)), timeoutMs); });
  const connecting = Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_s, chunk) {
        let frames;
        try { frames = reader.push(new Uint8Array(chunk)); } catch (e) { fail(e as Error); return; }
        for (const f of frames) { const w = waiter; if (w) { waiter = null; w(f); } else early.push(f); }
      },
      close() { fail(new LmcUsbError("the laser bridge closed the connection")); },
      error(_s, e) { fail(new LmcUsbError(`laser bridge connection error: ${e.message}`)); },
    },
  }).catch((e: unknown) => { throw new LmcUsbError(`could not reach the laser bridge at ${host}:${port} (${e instanceof Error ? e.message : String(e)}); is the bridge running and on the same Wi-Fi?`); });
  connecting.then(s => { if (closed) s.end(); }, () => undefined); // a link that arrives after the timeout is closed
  let socket: Awaited<typeof connecting>;
  try {
    socket = await Promise.race([connecting, connectTimeout]);
  } catch (error) {
    closed = true;
    throw error;
  } finally {
    clearTimeout(connectTimer);
  }
  socketRef = socket;
  const text = (p: Uint8Array) => new TextDecoder().decode(p);
  const hello = await answer(timeoutMs);
  let version = 0;
  try { version = Number((JSON.parse(text(hello.payload)) as { version?: unknown }).version); } catch { /* not a bridge */ }
  if (hello.type !== "H" || !text(hello.payload).includes("fabplane-lmc")) { socket.end(); throw new LmcUsbError(`${host}:${port} is not a fabPlane laser bridge`); }
  if (version < BRIDGE_VERSION) { socket.end(); throw new LmcUsbError(`the laser bridge at ${host} is too old (version ${version}); update it`); }
  let jobs = false;
  try { jobs = (JSON.parse(text(hello.payload)) as { jobs?: unknown }).jobs === true; } catch { /* raw mode */ }
  socket.write(frame("A", JSON.stringify({ token })));
  const auth = await answer(timeoutMs);
  if (auth.type !== "K") { socket.end(); throw new LmcUsbError(`the laser bridge refused the connection: ${text(auth.payload) || "unknown reason"}`); }

  let queue: Promise<unknown> = Promise.resolve();
  /** One request, one answer, strictly in order. */
  const request = (type: string, payload: Uint8Array | undefined, expect: string, ms = timeoutMs) => {
    const go = async () => {
      if (closed) throw new LmcUsbError("the laser bridge connection is closed");
      socket.write(frame(type, payload));
      const r = await answer(ms);
      if (r.type === "E") { fail(new LmcUsbError(`laser bridge: ${text(r.payload)}`)); throw new LmcUsbError(`laser bridge: ${text(r.payload)}`); }
      if (r.type !== expect) { fail(new LmcUsbError(`laser bridge sent ${r.type} instead of ${expect}`)); throw new LmcUsbError(`laser bridge sent ${r.type} instead of ${expect}`); }
      return r.payload;
    };
    const next = queue.then(go, go);
    queue = next.catch(() => undefined);
    return next;
  };
  // Heartbeat while idle, so the bridge knows this computer is still here during long arm moves.
  let lastRequest = Date.now();
  const heartbeat = setInterval(() => {
    if (closed) { clearInterval(heartbeat); return; }
    if (Date.now() - lastRequest >= pingMs) { lastRequest = Date.now(); request("P", undefined, "O", timeoutMs).catch(() => undefined); }
  }, Math.max(10, pingMs / 2));
  (heartbeat as unknown as { unref?: () => void }).unref?.();
  const touch = <T>(p: Promise<T>) => { lastRequest = Date.now(); return p; };
  return {
    remote: true,
    jobs,
    get closed() { return closed; },
    async rpc(type, body, ms) {
      const payload = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
      const answer = await touch(request(type, payload, type === "Q" ? "D" : "O", ms ?? timeoutMs));
      return type === "Q" ? JSON.parse(text(answer)) : null;
    },
    async write(packet) { await touch(request("W", packet, "O")); },
    read: () => touch(request("R", undefined, "D")),
    transact: packet => touch(request("C", packet, "D")),
    async close() {
      clearInterval(heartbeat);
      // Fails a request still waiting for its answer at once (Stop must not wait for its timeout).
      fail(new LmcUsbError("the laser bridge connection was closed"));
    },
  };
}
