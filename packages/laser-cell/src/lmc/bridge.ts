/**
 * Wi-Fi (network) link for the fabPlane USB laser driver.
 *
 * The laser's USB cable goes into a small computer next to it (a Raspberry Pi, a mini PC or a laptop) that
 * runs the bridge (`bun packages/laser-cell/src/lmc/bridge-cli.ts`). fabPlane connects to the bridge over
 * the network and the bridge passes the same 12-byte commands and 3072-byte list packets to the USB board.
 *
 * Wire format (TCP), every frame: type (1 byte ASCII) + payload length (uint32 LE) + payload.
 *   bridge → client  H  hello, JSON { bridge: "fabplane-lmc", version: 1 }
 *   client → bridge  A  auth, JSON { token }       (anything else before a valid token closes the link)
 *   bridge → client  K  auth accepted, JSON { device }
 *   client → bridge  W  write a 12- or 3072-byte packet to the board
 *   client → bridge  R  read the board's 8-byte reply
 *   bridge → client  D  the 8 reply bytes
 *   bridge → client  E  error, UTF-8 message (USB failure or bad request)
 * A shared token is required: anyone who can reach the bridge could otherwise fire the laser.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "bun";
import { COMMAND_BYTES, LIST_PACKET_BYTES } from "./protocol";
import { LmcUsbError, type LmcTransport } from "./usb";

export const BRIDGE_DEFAULT_PORT = 5021;
const MAX_FRAME = LIST_PACKET_BYTES + 1024;

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
  push(chunk: Uint8Array): Array<{ type: string; payload: Uint8Array }> {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out: Array<{ type: string; payload: Uint8Array }> = [];
    while (this.buf.length >= 5) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(1, true);
      if (len > MAX_FRAME) throw new LmcUsbError(`bridge frame of ${len} bytes is too large`);
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
};

type Session = { reader: FrameReader; authed: boolean; queue: Promise<unknown> };

/** Starts the bridge. One client at a time drives the board; the USB link is opened on first use. */
export async function startLmcBridge(options: BridgeOptions) {
  const log = options.log ?? (() => undefined);
  let usb: LmcTransport | null = null;
  let owner: Socket<Session> | null = null;
  const board = async () => (usb ??= await options.open());
  const server = Bun.listen<Session>({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? BRIDGE_DEFAULT_PORT,
    socket: {
      open(s) {
        s.data = { reader: new FrameReader(), authed: false, queue: Promise.resolve() };
        s.write(frame("H", JSON.stringify({ bridge: "fabplane-lmc", version: 1 })));
      },
      data(s, chunk) {
        let frames;
        try { frames = s.data.reader.push(new Uint8Array(chunk)); } catch { s.end(); return; }
        for (const f of frames) {
          s.data.queue = s.data.queue.then(async () => {
            if (!s.data.authed) {
              let token = "";
              try { token = String((JSON.parse(new TextDecoder().decode(f.payload)) as { token?: unknown }).token ?? ""); } catch { /* bad auth */ }
              if (f.type !== "A" || !sameToken(token, options.token)) { log(`refused ${s.remoteAddress}: wrong access key`); s.write(frame("E", "wrong access key")); s.end(); return; }
              if (owner && owner !== s) { s.write(frame("E", "another computer is already driving this laser")); s.end(); return; }
              s.data.authed = true;
              owner = s;
              log(`connected: ${s.remoteAddress}`);
              s.write(frame("K", JSON.stringify({ device: "9588:9899" })));
              return;
            }
            try {
              if (f.type === "W") {
                if (f.payload.length !== COMMAND_BYTES && f.payload.length !== LIST_PACKET_BYTES) throw new LmcUsbError(`bad packet size ${f.payload.length}`);
                await (await board()).write(f.payload);
              } else if (f.type === "R") {
                s.write(frame("D", await (await board()).read()));
              } else throw new LmcUsbError(`unknown request ${f.type}`);
            } catch (error) {
              s.write(frame("E", error instanceof Error ? error.message : String(error)));
              if (usb) { await usb.close().catch(() => undefined); usb = null; }
            }
          });
        }
      },
      close(s) {
        if (owner === s) { owner = null; log(`disconnected: ${s.remoteAddress}`); }
      },
    },
  });
  return {
    port: server.port,
    async stop() {
      server.stop(true);
      await usb?.close().catch(() => undefined);
      usb = null;
    },
  };
}

// ---------------------------------------------------------------- client (fabPlane)

/** fabPlane's side: an LmcTransport that talks to a bridge over TCP. */
export async function openBridgeLmc(host: string, port: number, token: string, timeoutMs = 3000): Promise<LmcTransport> {
  const reader = new FrameReader();
  const waiting: Array<(f: { type: string; payload: Uint8Array } | Error) => void> = [];
  const pending: Array<{ type: string; payload: Uint8Array }> = [];
  let closed = false;
  const deliver = (f: { type: string; payload: Uint8Array } | Error) => {
    const w = waiting.shift();
    if (w) w(f); else if (!(f instanceof Error)) pending.push(f);
  };
  const next = (ms = timeoutMs) => new Promise<{ type: string; payload: Uint8Array }>((resolve, reject) => {
    const queued = pending.shift();
    if (queued) return resolve(queued);
    if (closed) return reject(new LmcUsbError("the laser bridge closed the connection"));
    const timer = setTimeout(() => { const i = waiting.indexOf(handler); if (i >= 0) waiting.splice(i, 1); reject(new LmcUsbError(`the laser bridge at ${host}:${port} did not answer`)); }, ms);
    const handler = (f: { type: string; payload: Uint8Array } | Error) => { clearTimeout(timer); f instanceof Error ? reject(f) : resolve(f); };
    waiting.push(handler);
  });
  const socket = await Bun.connect({
    hostname: host,
    port,
    socket: {
      data(_s, chunk) { try { for (const f of reader.push(new Uint8Array(chunk))) deliver(f); } catch (e) { deliver(e as Error); } },
      close() { closed = true; while (waiting.length) waiting.shift()!(new LmcUsbError("the laser bridge closed the connection")); },
      error(_s, e) { deliver(new LmcUsbError(`laser bridge connection error: ${e.message}`)); },
    },
  }).catch((e: unknown) => { throw new LmcUsbError(`could not reach the laser bridge at ${host}:${port} (${e instanceof Error ? e.message : String(e)}); is the bridge running and on the same Wi-Fi?`); });
  const text = (p: Uint8Array) => new TextDecoder().decode(p);
  const hello = await next();
  if (hello.type !== "H" || !text(hello.payload).includes("fabplane-lmc")) { socket.end(); throw new LmcUsbError(`${host}:${port} is not a fabPlane laser bridge`); }
  socket.write(frame("A", JSON.stringify({ token })));
  const auth = await next();
  if (auth.type !== "K") { socket.end(); throw new LmcUsbError(`the laser bridge refused the connection: ${text(auth.payload) || "unknown reason"}`); }
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>) => { const p = queue.then(fn, fn); queue = p.catch(() => undefined); return p; };
  return {
    write: packet => serial(async () => {
      if (closed) throw new LmcUsbError("the laser bridge connection is closed");
      socket.write(frame("W", packet));
    }),
    read: () => serial(async () => {
      socket.write(frame("R"));
      const r = await next();
      if (r.type === "E") throw new LmcUsbError(`laser bridge: ${text(r.payload)}`);
      if (r.type !== "D") throw new LmcUsbError(`laser bridge sent ${r.type} instead of a reply`);
      return r.payload;
    }),
    async close() {
      closed = true;
      socket.end();
    },
  };
}
