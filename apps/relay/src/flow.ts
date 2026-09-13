/**
 * Backpressure between a phone socket and the daemon socket it is proxied over.
 *
 * Bun cannot pause reading a WebSocket, so "stop reading the phone" is realised as "stop
 * forwarding": while the daemon's send buffer is above `pauseAt`, the phone's messages are held
 * in a per-socket queue and flushed when the daemon drains. A phone whose held bytes would pass
 * `closeAt` is closed (1013, try again later) instead of growing relay memory, and a phone that
 * itself stops reading and buffers past `closeAt` is closed the same way. Proxied HTTP is refused
 * with 503 while the daemon is above `closeAt`.
 */
export interface FlowConfig {
  /** Daemon buffered bytes above which phone messages are queued instead of sent. */
  pauseAt: number;
  /** Held or phone-buffered bytes above which the phone socket is closed. */
  closeAt: number;
}

export const DEFAULT_FLOW: FlowConfig = { pauseAt: 1024 * 1024, closeAt: 8 * 1024 * 1024 };

/** Close code for a peer that must back off and retry. */
export const CLOSE_TRY_AGAIN_LATER = 1013;

/** Outbound frames for one phone, spilled while its daemon is under backpressure. */
export class HeldQueue {
  private items: string[] = [];
  bytes = 0;

  get length(): number {
    return this.items.length;
  }

  /** Queues `frame`; false when that would take the queue past `closeAt` (nothing is queued). */
  push(frame: string, closeAt: number): boolean {
    const size = Buffer.byteLength(frame);
    if (this.bytes + size > closeAt) return false;
    this.items.push(frame);
    this.bytes += size;
    return true;
  }

  /** Hands queued frames to `send` in order, stopping at the first it refuses. */
  flush(send: (frame: string) => boolean): void {
    let i = 0;
    for (; i < this.items.length; i++) {
      const frame = this.items[i]!;
      if (!send(frame)) break;
      this.bytes -= Buffer.byteLength(frame);
    }
    if (i > 0) this.items = this.items.slice(i);
  }

  clear(): void {
    this.items = [];
    this.bytes = 0;
  }
}
