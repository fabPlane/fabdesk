/**
 * Feetech ST3215 / STS3215 bus-servo protocol, as used by the ElRobot and SO-101 arms.
 *
 * Packet: FF FF <id> <len = params + 2> <instruction> <params…> <checksum = ~(id + len + instr + params) & 0xFF>.
 * Register map and instruction set follow NormaCore's driver
 * (norma-core/software/drivers/st3215/src/protocol), which is the reference for ElRobot.
 */

export const BROADCAST_ID = 0xfe;
export const DEFAULT_BAUD = 1_000_000;
/** One revolution is 4096 steps; the usable position range is 0..4095. */
export const STEPS_PER_TURN = 4096;
export const MAX_POSITION = 4095;

export const Instruction = {
  ping: 0x01,
  read: 0x02,
  write: 0x03,
  regWrite: 0x04,
  action: 0x05,
  reset: 0x06,
  syncWrite: 0x83,
} as const;

/** RAM registers used by the laser cell. Addresses match NormaCore's `RamRegister`. */
export const Reg = {
  modelNumber: 0x00,
  id: 0x05,
  minAngleLimit: 0x09,
  maxAngleLimit: 0x0b,
  torqueEnable: 0x28,
  acceleration: 0x29,
  goalPosition: 0x2a,
  goalTime: 0x2c,
  goalSpeed: 0x2e,
  torqueLimit: 0x30,
  lock: 0x37,
  presentPosition: 0x38,
  presentSpeed: 0x3a,
  presentLoad: 0x3c,
  presentVoltage: 0x3e,
  presentTemperature: 0x3f,
  status: 0x41,
  moving: 0x42,
  presentCurrent: 0x45,
} as const;

export class St3215Error extends Error {
  override name = "St3215Error";
}

export function checksum(bytes: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i++) sum += bytes[i]!;
  return ~sum & 0xff;
}

function assertByte(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new St3215Error(`${what} must be a byte, got ${value}`);
}

/** Build one instruction packet. */
export function packet(id: number, instruction: number, params: ArrayLike<number> = []): Uint8Array {
  assertByte(id, "servo id");
  assertByte(instruction, "instruction");
  if (params.length > 250) throw new St3215Error("packet too long");
  const out = new Uint8Array(params.length + 6);
  out[0] = 0xff;
  out[1] = 0xff;
  out[2] = id;
  out[3] = params.length + 2;
  out[4] = instruction;
  for (let i = 0; i < params.length; i++) {
    assertByte(params[i]!, "parameter");
    out[5 + i] = params[i]!;
  }
  out[out.length - 1] = checksum(out.subarray(2, out.length - 1));
  return out;
}

export const u16le = (value: number): [number, number] => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new St3215Error(`value ${value} does not fit 16 bits`);
  return [value & 0xff, (value >> 8) & 0xff];
};

export const pingPacket = (id: number) => packet(id, Instruction.ping);
export const readPacket = (id: number, address: number, length: number) => packet(id, Instruction.read, [address, length]);
export const writePacket = (id: number, address: number, data: ArrayLike<number>) => packet(id, Instruction.write, [address, ...Array.from(data)]);

/** Sync-write the same register block to several servos in one broadcast packet (no reply). */
export function syncWritePacket(address: number, entries: ReadonlyArray<{ id: number; data: ArrayLike<number> }>): Uint8Array {
  if (!entries.length) throw new St3215Error("sync write needs at least one servo");
  const len = entries[0]!.data.length;
  const params: number[] = [address, len];
  for (const entry of entries) {
    if (entry.data.length !== len) throw new St3215Error("sync write entries must have equal length");
    params.push(entry.id, ...Array.from(entry.data));
  }
  return packet(BROADCAST_ID, Instruction.syncWrite, params);
}

/** Goal position + goal time + goal speed for one servo, as a 6-byte block starting at 0x2A. */
export function goalBlock(position: number, speed: number, timeMs = 0): number[] {
  return [...u16le(clampPosition(position)), ...u16le(timeMs), ...u16le(speed)];
}

export function clampPosition(position: number): number {
  return Math.max(0, Math.min(MAX_POSITION, Math.round(position)));
}

/** Present position uses bit 15 as a sign bit on some firmware; normalise into 0..4095 like NormaCore. */
export function normalPosition(raw: number): number {
  if (raw & 0x8000) return (STEPS_PER_TURN - (raw & MAX_POSITION)) & MAX_POSITION;
  return raw & MAX_POSITION;
}

export type StatusPacket = { id: number; error: number; params: Uint8Array; length: number };

/**
 * Parse one status (reply) packet from the start of `buf`, skipping leading noise.
 * Returns null when more bytes are needed. Throws on a bad checksum.
 */
export function parseStatus(buf: Uint8Array): { packet: StatusPacket; consumed: number } | null {
  let start = 0;
  while (start + 1 < buf.length && !(buf[start] === 0xff && buf[start + 1] === 0xff)) start++;
  // FF FF FF <id>: a third FF is noise before the id, not the id itself (0xFF is never a valid id).
  while (start + 2 < buf.length && buf[start + 2] === 0xff) start++;
  if (start + 5 > buf.length) return null;
  const id = buf[start + 2]!;
  const len = buf[start + 3]!;
  if (len < 2) throw new St3215Error(`bad reply length ${len}`);
  const end = start + 4 + len;
  if (end > buf.length) return null;
  const body = buf.subarray(start + 2, end - 1);
  const sum = buf[end - 1]!;
  if (checksum(body) !== sum) throw new St3215Error(`bad reply checksum from servo ${id}`);
  return { packet: { id, error: buf[start + 4]!, params: buf.slice(start + 5, end - 1), length: len }, consumed: end };
}

/** Servo error bits from the status packet's error byte. */
export function describeServoError(bits: number): string[] {
  const names: Array<[number, string]> = [
    [0x01, "voltage"],
    [0x02, "angle sensor"],
    [0x04, "overheat"],
    [0x08, "over-current"],
    [0x20, "overload"],
  ];
  return names.filter(([bit]) => bits & bit).map(([, name]) => name);
}

/** A byte-level serial link. Implementations: Windows COM (FFI), POSIX tty, or a test fake. */
export interface SerialLink {
  write(bytes: Uint8Array): Promise<void>;
  /** Read whatever is available, waiting at most `timeoutMs` for the first byte. */
  read(timeoutMs: number): Promise<Uint8Array>;
  flushInput(): Promise<void>;
  close(): Promise<void>;
}

/** Request/response client for one ST3215 bus. Calls are serialised. */
export class St3215Bus {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly link: SerialLink, private readonly timeoutMs = 60) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async transact(request: Uint8Array, expectReply: boolean): Promise<StatusPacket | null> {
    await this.link.flushInput();
    await this.link.write(request);
    if (!expectReply) return null;
    const id = request[2]!;
    let buf: Uint8Array = new Uint8Array(0);
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new St3215Error(`servo ${id} did not answer within ${this.timeoutMs} ms`);
      const chunk = await this.link.read(remaining);
      if (chunk.length) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf);
        merged.set(chunk, buf.length);
        buf = merged;
      }
      // Half-duplex adapters echo our own request byte for byte; drop it and keep the servo's reply.
      if (buf.length >= request.length && request.every((byte, i) => buf[i] === byte)) buf = buf.subarray(request.length);
      let parsed = parseStatus(buf);
      while (parsed && parsed.packet.id !== id) {
        buf = buf.subarray(parsed.consumed);
        parsed = parseStatus(buf);
      }
      if (parsed) return parsed.packet;
    }
  }

  ping(id: number): Promise<boolean> {
    return this.exclusive(async () => {
      try {
        await this.transact(pingPacket(id), true);
        return true;
      } catch (error) {
        if (error instanceof St3215Error) return false;
        throw error;
      }
    });
  }

  read(id: number, address: number, length: number): Promise<Uint8Array> {
    return this.exclusive(async () => {
      const reply = (await this.transact(readPacket(id, address, length), true))!;
      if (reply.params.length !== length) throw new St3215Error(`servo ${id} returned ${reply.params.length} bytes, expected ${length}`);
      if (reply.error) throw new St3215Error(`servo ${id} reports ${describeServoError(reply.error).join(", ") || `error 0x${reply.error.toString(16)}`}`);
      return reply.params;
    });
  }

  async readU16(id: number, address: number): Promise<number> {
    const bytes = await this.read(id, address, 2);
    return bytes[0]! | (bytes[1]! << 8);
  }

  write(id: number, address: number, data: ArrayLike<number>): Promise<void> {
    return this.exclusive(async () => {
      const reply = await this.transact(writePacket(id, address, data), id !== BROADCAST_ID);
      if (reply?.error) throw new St3215Error(`servo ${id} reports ${describeServoError(reply.error).join(", ") || `error 0x${reply.error.toString(16)}`}`);
    });
  }

  syncWrite(address: number, entries: ReadonlyArray<{ id: number; data: ArrayLike<number> }>): Promise<void> {
    return this.exclusive(async () => {
      await this.transact(syncWritePacket(address, entries), false);
    });
  }

  async position(id: number): Promise<number> {
    return normalPosition(await this.readU16(id, Reg.presentPosition));
  }

  async moving(id: number): Promise<boolean> {
    return (await this.read(id, Reg.moving, 1))[0] !== 0;
  }

  async torque(ids: readonly number[], on: boolean): Promise<void> {
    await this.syncWrite(Reg.torqueEnable, ids.map(id => ({ id, data: [on ? 1 : 0] })));
  }

  close(): Promise<void> {
    return this.link.close();
  }
}
