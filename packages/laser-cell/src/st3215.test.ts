import { describe, expect, test } from "bun:test";
import { BROADCAST_ID, Reg, St3215Bus, checksum, goalBlock, normalPosition, packet, parseStatus, pingPacket, readPacket, syncWritePacket, type SerialLink } from "./st3215";
import { Arm, DEFAULT_ARM_CONFIG, poseReached, stepDistance, syncedSpeeds } from "./arm";

describe("ST3215 packets", () => {
  test("ping matches the Feetech reference bytes", () => {
    // FF FF 01 02 01 FB is the canonical ping for servo 1.
    expect(Array.from(pingPacket(1))).toEqual([0xff, 0xff, 0x01, 0x02, 0x01, 0xfb]);
  });

  test("read present position", () => {
    const bytes = Array.from(readPacket(3, Reg.presentPosition, 2));
    expect(bytes.slice(0, 7)).toEqual([0xff, 0xff, 3, 4, 0x02, 0x38, 2]);
    expect(bytes[7]).toBe(checksum([3, 4, 0x02, 0x38, 2]));
  });

  test("sync write of goal blocks", () => {
    const p = syncWritePacket(Reg.goalPosition, [
      { id: 1, data: goalBlock(2048, 500) },
      { id: 2, data: goalBlock(1000, 250) },
    ]);
    expect(p[2]).toBe(BROADCAST_ID);
    expect(p[3]).toBe(2 * 7 + 4);
    expect(p[4]).toBe(0x83);
    expect(Array.from(p.subarray(5, 7))).toEqual([Reg.goalPosition, 6]);
    expect(Array.from(p.subarray(7, 14))).toEqual([1, 0x00, 0x08, 0, 0, 0xf4, 0x01]);
  });

  test("goal positions are clamped into range", () => {
    expect(goalBlock(5000, 0).slice(0, 2)).toEqual([0xff, 0x0f]);
    expect(goalBlock(-3, 0).slice(0, 2)).toEqual([0, 0]);
  });

  test("rejects out-of-range bytes", () => {
    expect(() => packet(300, 1)).toThrow();
  });

  test("parses a status packet after noise", () => {
    const reply = [0xff, 0xff, 1, 4, 0, 0x00, 0x08];
    reply.push(checksum(reply.slice(2)));
    const parsed = parseStatus(new Uint8Array([0x00, 0x13, ...reply]));
    expect(parsed?.packet).toMatchObject({ id: 1, error: 0 });
    expect(Array.from(parsed!.packet.params)).toEqual([0x00, 0x08]);
    expect(parsed?.consumed).toBe(2 + reply.length);
  });

  test("waits for more bytes and rejects bad checksums", () => {
    expect(parseStatus(new Uint8Array([0xff, 0xff, 1, 4]))).toBeNull();
    expect(() => parseStatus(new Uint8Array([0xff, 0xff, 1, 2, 0, 0x00]))).toThrow("checksum");
  });

  test("sign-bit positions normalise like NormaCore", () => {
    expect(normalPosition(0x8000 | 10)).toBe(4086);
    expect(normalPosition(2048)).toBe(2048);
  });
});

/** A simulated bus: servos with a position that moves toward their goal on every poll. */
export function fakeServos(ids: number[], options: { echo?: boolean; start?: number; blocked?: Record<number, number> } = {}) {
  const regs = new Map<number, Uint8Array>();
  for (const id of ids) {
    const mem = new Uint8Array(0x50);
    const start = options.start ?? 2048;
    mem[Reg.presentPosition] = start & 0xff;
    mem[Reg.presentPosition + 1] = start >> 8;
    mem[Reg.goalPosition] = start & 0xff;
    mem[Reg.goalPosition + 1] = start >> 8;
    mem[Reg.presentVoltage] = 120;
    mem[Reg.presentTemperature] = 31;
    regs.set(id, mem);
  }
  let inbox: number[] = [];
  const writes: Uint8Array[] = [];
  const step = () => {
    for (const [id, mem] of regs) {
      const goal = mem[Reg.goalPosition]! | (mem[Reg.goalPosition + 1]! << 8);
      let pos = mem[Reg.presentPosition]! | (mem[Reg.presentPosition + 1]! << 8);
      const limit = options.blocked?.[id];
      const target = limit !== undefined && goal < limit ? limit : goal;
      if (!mem[Reg.torqueEnable]) continue;
      pos += Math.sign(target - pos) * Math.min(Math.abs(target - pos), 400);
      mem[Reg.presentPosition] = pos & 0xff;
      mem[Reg.presentPosition + 1] = pos >> 8;
      mem[Reg.moving] = pos === target ? 0 : 1;
    }
  };
  const reply = (id: number, params: number[]) => {
    const body = [id, params.length + 2, 0, ...params];
    return [0xff, 0xff, ...body, checksum(body)];
  };
  const link: SerialLink = {
    async write(bytes) {
      writes.push(bytes);
      if (options.echo) inbox.push(...bytes);
      const id = bytes[2]!;
      const instr = bytes[4]!;
      const params = Array.from(bytes.subarray(5, bytes.length - 1));
      if (instr === 0x83) {
        const [address, len, ...rest] = params;
        for (let i = 0; i < rest.length; i += len! + 1) regs.get(rest[i]!)?.set(rest.slice(i + 1, i + 1 + len!), address);
        return;
      }
      const mem = regs.get(id);
      if (!mem) return;
      if (instr === 0x01) inbox.push(...reply(id, []));
      if (instr === 0x02) {
        step();
        inbox.push(...reply(id, Array.from(mem.subarray(params[0]!, params[0]! + params[1]!))));
      }
      if (instr === 0x03) {
        mem.set(params.slice(1), params[0]);
        inbox.push(...reply(id, []));
      }
    },
    async read() {
      const out = new Uint8Array(inbox);
      inbox = [];
      return out;
    },
    async flushInput() {
      inbox = [];
    },
    async close() {},
  };
  return { link, regs, writes };
}

describe("St3215Bus over a simulated adapter", () => {
  test("ping and read through an echoing half-duplex adapter", async () => {
    const { link } = fakeServos([1, 2], { echo: true });
    const bus = new St3215Bus(link);
    expect(await bus.ping(1)).toBe(true);
    expect(await bus.ping(9)).toBe(false);
    expect(await bus.position(2)).toBe(2048);
  });
});

describe("Arm", () => {
  test("stepDistance wraps around", () => {
    expect(stepDistance(10, 4090)).toBe(16);
    expect(poseReached({ 1: 100 }, { 1: 110 }, 18)).toBe(true);
    expect(poseReached({ 1: 100 }, { 1: 130 }, 18)).toBe(false);
  });

  test("synced speeds finish every joint together", () => {
    expect(syncedSpeeds({ 1: 0, 2: 0 }, { 1: 1000, 2: 250 }, 800)).toEqual({ 1: 800, 2: 200 });
  });

  test("moves to a taught pose and reports arrival", async () => {
    const ids = [1, 2, 3];
    const { link } = fakeServos(ids);
    const arm = new Arm(new St3215Bus(link), { ...DEFAULT_ARM_CONFIG, jointIds: [1, 2], gripperId: 3 });
    const reached = await arm.moveTo({ 1: 3000, 2: 1000 });
    expect(reached[1]).toBe(3000);
    expect(reached[2]).toBe(1000);
  });

  test("a blocked joint times out instead of reporting arrival", async () => {
    const { link } = fakeServos([1, 2], { blocked: { 1: 2500 } });
    const arm = new Arm(new St3215Bus(link), { ...DEFAULT_ARM_CONFIG, jointIds: [1], gripperId: 2, moveTimeoutMs: 300 });
    await expect(arm.moveTo({ 1: 1000 })).rejects.toThrow("joint 1");
  });

  test("grip detects a board between the jaws", async () => {
    const empty = fakeServos([1, 2]);
    const armEmpty = new Arm(new St3215Bus(empty.link), { ...DEFAULT_ARM_CONFIG, jointIds: [1], gripperId: 2 });
    expect((await armEmpty.grip(1200)).held).toBe(false);
    const holding = fakeServos([1, 2], { blocked: { 2: 1500 } });
    const armHolding = new Arm(new St3215Bus(holding.link), { ...DEFAULT_ARM_CONFIG, jointIds: [1], gripperId: 2 });
    expect((await armHolding.grip(1200)).held).toBe(true);
  });
});
