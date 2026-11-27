/**
 * BJJCZ "LMC" galvo controller protocol (the boards EZCAD2 and LightBurn drive; LightBurn drives the
 * ComMarker Omni X this way). Ported from galvoplotter (MIT License, Copyright (c) 2023 MeerK40t,
 * https://github.com/meerk40t/galvoplotter), which documents the protocol from observed USB traffic.
 *
 * - Every command is six little-endian uint16: opcode, then five parameters (12 bytes).
 * - Single (realtime) commands go out alone and the board answers 8 bytes (four uint16; the 4th is status).
 * - List commands (opcode 0x8000+) are packed 256 to a 3072-byte packet; unused slots hold the
 *   end-of-list no-op. The board stores packets and runs them on ExecuteList.
 * - Positions are galvo units 0..0xFFFF across the lens field, 0x8000 = field centre.
 */

// ---------------------------------------------------------------- list commands
export const List = {
  JumpTo: 0x8001,
  EndOfList: 0x8002,
  LaserOnPoint: 0x8003,
  DelayTime: 0x8004,
  MarkTo: 0x8005,
  JumpSpeed: 0x8006,
  LaserOnDelay: 0x8007,
  LaserOffDelay: 0x8008,
  MarkFreq: 0x800a,
  MarkPowerRatio: 0x800b,
  MarkSpeed: 0x800c,
  JumpDelay: 0x800d,
  PolygonDelay: 0x800f,
  WritePort: 0x8011,
  MarkCurrent: 0x8012,
  QSwitchPeriod: 0x801b,
  SetCo2FPK: 0x801e,
  FiberOpenMO: 0x8021,
  ReadyMark: 0x8051,
} as const;

// ---------------------------------------------------------------- single (realtime) commands
export const Cmd = {
  DisableLaser: 0x0002,
  EnableLaser: 0x0004,
  ExecuteList: 0x0005,
  SetPwmPulseWidth: 0x0006,
  GetVersion: 0x0007,
  GetSerialNo: 0x0009,
  GetListStatus: 0x000a,
  GetPositionXY: 0x000c,
  GotoXY: 0x000d,
  WriteCorLine: 0x0010,
  ResetList: 0x0012,
  RestartList: 0x0013,
  WriteCorTable: 0x0015,
  SetControlMode: 0x0016,
  SetDelayMode: 0x0017,
  SetEndOfList: 0x0019,
  SetFirstPulseKiller: 0x001a,
  SetLaserMode: 0x001b,
  SetTiming: 0x001c,
  SetStandby: 0x001d,
  SetPwmHalfPeriod: 0x001e,
  StopExecute: 0x001f,
  StopList: 0x0020,
  WritePort: 0x0021,
  WriteAnalogPort1: 0x0022,
  ReadPort: 0x0025,
  GetMarkCount: 0x002d,
  SetFpkParam2: 0x002e,
  FiberSetMo: 0x0033,
  DisableZ: 0x0039,
  EnableZ: 0x003a,
  Reset: 0x0040,
  GetMarkTime: 0x0041,
} as const;

/** Status bits in the 4th word of a reply. */
export const Status = { BUSY: 0x04, READY: 0x20, AXIS: 0x40 } as const;

export const COMMAND_BYTES = 12;
export const LIST_PACKET_BYTES = 0xc00;
export const LIST_COMMANDS_PER_PACKET = LIST_PACKET_BYTES / COMMAND_BYTES;
export const REPLY_BYTES = 8;
export const GALVO_CENTER = 0x8000;
export const GALVO_MAX = 0xffff;

const u16 = (v: number) => {
  const n = Math.round(v);
  if (!Number.isFinite(n) || n < 0 || n > 0xffff) throw new RangeError(`LMC parameter ${v} is outside 0..65535`);
  return n;
};

/** One 12-byte command: opcode + five uint16 parameters, little-endian. */
export function command(op: number, ...params: number[]): Uint8Array {
  if (params.length > 5) throw new RangeError("an LMC command has at most five parameters");
  const out = new Uint8Array(COMMAND_BYTES);
  const view = new DataView(out.buffer);
  view.setUint16(0, u16(op), true);
  params.forEach((p, i) => view.setUint16(2 + i * 2, u16(p), true));
  return out;
}

/** Signed delay as the board expects: magnitude, then 0x8000 when negative. */
export const signedDelay = (us: number): [number, number] => [Math.abs(Math.round(us)), us < 0 ? 0x8000 : 0];

export type Reply = { words: [number, number, number, number]; status: number };

export function parseReply(bytes: Uint8Array): Reply {
  if (bytes.length < REPLY_BYTES) throw new RangeError(`LMC reply has ${bytes.length} bytes, expected ${REPLY_BYTES}`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, REPLY_BYTES);
  const words: Reply["words"] = [v.getUint16(0, true), v.getUint16(2, true), v.getUint16(4, true), v.getUint16(6, true)];
  return { words, status: words[3] };
}

export const isBusy = (status: number) => (status & Status.BUSY) !== 0;
export const isReady = (status: number) => (status & Status.READY) !== 0;

/** Packs list commands into 3072-byte packets padded with the end-of-list no-op. */
export class ListPackets {
  private packets: Uint8Array[] = [];
  private current: Uint8Array | null = null;
  private index = 0;

  add(op: number, ...params: number[]): this {
    if (op < 0x8000) throw new RangeError(`0x${op.toString(16)} is not a list command`);
    if (!this.current || this.index >= LIST_PACKET_BYTES) this.newPacket();
    this.current!.set(command(op, ...params), this.index);
    this.index += COMMAND_BYTES;
    return this;
  }

  get commandCount(): number {
    return this.packets.length * LIST_COMMANDS_PER_PACKET - (this.current ? (LIST_PACKET_BYTES - this.index) / COMMAND_BYTES : 0);
  }

  /** All packets; the list always ends with an end-of-list command. */
  finish(): Uint8Array[] {
    this.add(List.EndOfList);
    return this.packets.slice();
  }

  private newPacket() {
    this.current = new Uint8Array(LIST_PACKET_BYTES);
    const nop = command(List.EndOfList);
    for (let i = 0; i < LIST_PACKET_BYTES; i += COMMAND_BYTES) this.current.set(nop, i);
    this.packets.push(this.current);
    this.index = 0;
  }
}

/** Decodes packets back into commands (tests, logs). */
export function decodeList(packets: Uint8Array[]): Array<{ op: number; params: number[] }> {
  const out: Array<{ op: number; params: number[] }> = [];
  for (const p of packets) {
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength);
    for (let i = 0; i < p.byteLength; i += COMMAND_BYTES) {
      out.push({ op: v.getUint16(i, true), params: [1, 2, 3, 4, 5].map(k => v.getUint16(i + k * 2, true)) });
    }
  }
  return out;
}
