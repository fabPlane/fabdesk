/**
 * A WebSocket peer built on a raw TCP socket, for tests that need what a real client never
 * offers: not answering pings (idle timeout) and not reading (backpressure). Server → client
 * frames are unmasked, so decoding them is a few lines.
 */
import net from "node:net";

export type RawFrame = { opcode: number; payload: Buffer };

export class RawWebSocket {
  readonly frames: RawFrame[] = [];
  private buf = Buffer.alloc(0);
  private handshakeDone = false;
  private closed = false;
  private waiters: Array<() => void> = [];
  private closeWaiters: Array<() => void> = [];
  private constructor(readonly sock: net.Socket) {}

  static async connect(url: string, headers: Record<string, string> = {}): Promise<RawWebSocket> {
    const u = new URL(url);
    const sock = net.connect(Number(u.port), u.hostname);
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", reject);
    });
    const raw = new RawWebSocket(sock);
    sock.on("data", (chunk: Buffer) => raw.onData(chunk));
    sock.on("close", () => {
      raw.closed = true;
      for (const w of raw.closeWaiters.splice(0)) w();
    });
    sock.on("error", () => {});
    const lines = [
      `GET ${u.pathname}${u.search} HTTP/1.1`,
      `Host: ${u.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
      "Sec-WebSocket-Version: 13",
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ];
    sock.write(lines.join("\r\n") + "\r\n\r\n");
    await raw.until(() => raw.handshakeDone);
    return raw;
  }

  /** HTTP status of the upgrade answer. */
  status = 0;

  private onData(chunk: Buffer) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.handshakeDone) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = this.buf.subarray(0, end).toString();
      this.status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
      this.buf = this.buf.subarray(end + 4);
      this.handshakeDone = true;
    }
    for (;;) {
      if (this.buf.length < 2) break;
      const opcode = this.buf[0]! & 0x0f;
      let len = this.buf[1]! & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        len = Number(this.buf.readBigUInt64BE(2));
        offset = 10;
      }
      if (this.buf.length < offset + len) break;
      this.frames.push({ opcode, payload: Buffer.from(this.buf.subarray(offset, offset + len)) });
      this.buf = this.buf.subarray(offset + len);
    }
    for (const w of this.waiters.splice(0)) w();
  }

  private until(cond: () => boolean, ms = 5000): Promise<void> {
    if (cond()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("raw ws: timed out")), ms);
      const check = () => {
        if (cond()) {
          clearTimeout(timer);
          resolve();
        } else this.waiters.push(check);
      };
      this.waiters.push(check);
    });
  }

  /** Resolves once a frame with `opcode` has arrived. */
  frame(opcode: number, ms = 5000): Promise<RawFrame> {
    return this.until(() => this.frames.some((f) => f.opcode === opcode), ms).then(
      () => this.frames.find((f) => f.opcode === opcode)!,
    );
  }

  /** Close code carried by the server's close frame, if one arrived. */
  closeCode(): number | null {
    const f = this.frames.find((f) => f.opcode === 0x8);
    return f && f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null;
  }

  /** Text payloads of every data frame so far, concatenated. */
  text(): string {
    return this.frames
      .filter((f) => f.opcode === 0x1)
      .map((f) => f.payload.toString())
      .join("");
  }

  pause() {
    this.sock.pause();
  }
  resume() {
    this.sock.resume();
  }
  isClosed() {
    return this.closed;
  }
  onClosed(ms = 5000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("raw ws: not closed")), ms);
      this.closeWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  destroy() {
    this.sock.destroy();
  }
}
