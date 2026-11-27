/**
 * ElRobot (7+1 DoF, ST3215 servos) driven by taught poses.
 *
 * The cell never needs inverse kinematics: you relax the arm, hand-guide it to each station
 * (stack, laser jig, output tray, safe clear pose) and fabPlane records the raw servo positions.
 * Moves replay those poses with a synchronised goal-position write and wait until every joint
 * has arrived, so "the arm is clear of the laser" is a measured fact, not a timer.
 */
import { MAX_POSITION, Reg, St3215Bus, clampPosition, goalBlock, normalPosition, u16le } from "./st3215";

/** Servo id → raw position (0..4095). */
export type Pose = Record<string, number>;

export type ArmConfig = {
  /** Servo ids on the bus, joints first, gripper last. ElRobot ships as 1..8 (8 = gripper). */
  jointIds: number[];
  gripperId: number;
  /** Goal speed in steps/s for normal moves (0 = servo maximum; avoid). */
  speed: number;
  /** Slower speed for the last centimetres into the jig / onto the stack. */
  approachSpeed: number;
  /** Acceleration register value (×100 steps/s²). */
  acceleration: number;
  /** A joint has arrived when it is within this many steps of its goal. */
  toleranceSteps: number;
  /** Give up on a move after this long. */
  moveTimeoutMs: number;
  /** Torque limit for the gripper while closing, in 0.1 % of stall torque (1000 = 100 %). */
  gripTorqueLimit: number;
  /** A board is held when the closed gripper stops at least this many steps short of its empty-closed pose. */
  gripDetectSteps: number;
};

export const DEFAULT_ARM_CONFIG: ArmConfig = {
  jointIds: [1, 2, 3, 4, 5, 6, 7],
  gripperId: 8,
  speed: 1200,
  approachSpeed: 350,
  acceleration: 30,
  toleranceSteps: 18,
  moveTimeoutMs: 8000,
  gripTorqueLimit: 450,
  gripDetectSteps: 40,
};

export type JointState = { id: number; position: number; temperature: number; voltage: number; load: number; moving: boolean };

export type MoveOptions = { speed?: number; signal?: AbortSignal; onProgress?: (fraction: number) => void };

export class ArmError extends Error {
  override name = "ArmError";
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function poseIds(pose: Pose): number[] {
  return Object.keys(pose).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
}

/** Shortest circular distance between two raw positions. */
export function stepDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % (MAX_POSITION + 1);
  return Math.min(d, MAX_POSITION + 1 - d);
}

export function poseReached(goal: Pose, present: Pose, tolerance: number): boolean {
  return poseIds(goal).every(id => present[id] !== undefined && stepDistance(goal[id]!, present[id]!) <= tolerance);
}

/** Per-joint speeds so every joint finishes together (smooth, predictable path between taught poses). */
export function syncedSpeeds(from: Pose, to: Pose, maxSpeed: number): Record<number, number> {
  const ids = poseIds(to);
  const distances = ids.map(id => (from[id] === undefined ? 0 : stepDistance(from[id]!, to[id]!)));
  const longest = Math.max(1, ...distances);
  const speeds: Record<number, number> = {};
  ids.forEach((id, i) => {
    speeds[id] = Math.max(20, Math.round((maxSpeed * distances[i]!) / longest));
  });
  return speeds;
}

export class Arm {
  constructor(readonly bus: St3215Bus, readonly config: ArmConfig = DEFAULT_ARM_CONFIG) {}

  get allIds(): number[] {
    return [...this.config.jointIds, this.config.gripperId];
  }

  /** Ping every configured servo; returns the ids that did not answer. */
  async missing(): Promise<number[]> {
    const missing: number[] = [];
    for (const id of this.allIds) if (!(await this.bus.ping(id))) missing.push(id);
    return missing;
  }

  async read(): Promise<Pose> {
    const pose: Pose = {};
    for (const id of this.allIds) pose[id] = await this.bus.position(id);
    return pose;
  }

  async states(): Promise<JointState[]> {
    const out: JointState[] = [];
    for (const id of this.allIds) {
      // One 11-byte read covers present position .. moving (0x38..0x42).
      const b = await this.bus.read(id, Reg.presentPosition, Reg.moving - Reg.presentPosition + 1);
      const at = (reg: number) => b[reg - Reg.presentPosition]!;
      const load = at(Reg.presentLoad) | (at(Reg.presentLoad + 1) << 8);
      out.push({
        id,
        position: normalPosition(at(Reg.presentPosition) | (at(Reg.presentPosition + 1) << 8)),
        temperature: at(Reg.presentTemperature),
        voltage: at(Reg.presentVoltage) / 10,
        load: (load & 0x400 ? -1 : 1) * (load & 0x3ff) / 10,
        moving: at(Reg.moving) !== 0,
      });
    }
    return out;
  }

  /** Relax every joint so the arm can be hand-guided while teaching. Support the arm first. */
  async relax(): Promise<void> {
    await this.bus.torque(this.allIds, false);
  }

  /** Hold the current pose with torque on (goal = present first, so nothing jumps). */
  async hold(): Promise<Pose> {
    const present = await this.read();
    await this.bus.syncWrite(Reg.goalPosition, this.allIds.map(id => ({ id, data: u16le(clampPosition(present[id]!)) })));
    await this.bus.torque(this.allIds, true);
    return present;
  }

  /** Stop where it is: freeze every joint at its present position. Keeps the board in the gripper. */
  async stop(): Promise<void> {
    try {
      const present = await this.read();
      await this.bus.syncWrite(Reg.goalPosition, this.allIds.map(id => ({ id, data: u16le(clampPosition(present[id]!)) })));
    } catch {
      // If the bus is gone the servos keep their last goal; nothing more we can do from here.
    }
  }

  async prepare(): Promise<void> {
    await this.bus.syncWrite(Reg.acceleration, this.allIds.map(id => ({ id, data: [this.config.acceleration] })));
    await this.bus.syncWrite(Reg.torqueLimit, this.allIds.map(id => ({ id, data: u16le(1000) })));
  }

  /** Move to a taught pose and wait until every joint in it has arrived. */
  async moveTo(goal: Pose, options: MoveOptions = {}): Promise<Pose> {
    const ids = poseIds(goal);
    if (!ids.length) throw new ArmError("pose has no joints");
    const unknown = ids.filter(id => !this.allIds.includes(id));
    if (unknown.length) throw new ArmError(`pose uses servo id(s) ${unknown.join(", ")} that are not configured`);
    const start = await this.read();
    const speeds = syncedSpeeds(start, goal, options.speed ?? this.config.speed);
    await this.bus.torque(ids, true);
    await this.bus.syncWrite(Reg.goalPosition, ids.map(id => ({ id, data: goalBlock(goal[id]!, speeds[id]!) })));
    const total = Math.max(1, ...ids.map(id => stepDistance(start[id]!, goal[id]!)));
    const deadline = Date.now() + this.config.moveTimeoutMs;
    for (;;) {
      if (options.signal?.aborted) {
        await this.stop();
        throw new ArmError("move stopped");
      }
      const present = await this.read();
      const left = Math.max(...ids.map(id => stepDistance(present[id]!, goal[id]!)));
      options.onProgress?.(Math.max(0, Math.min(1, 1 - left / total)));
      if (poseReached(goal, present, this.config.toleranceSteps)) return present;
      if (Date.now() > deadline) {
        await this.stop();
        const stuck = ids.filter(id => stepDistance(present[id]!, goal[id]!) > this.config.toleranceSteps);
        throw new ArmError(`arm did not reach the pose in ${this.config.moveTimeoutMs / 1000}s (joint ${stuck.join(", ")} blocked or out of reach)`);
      }
      await sleep(25);
    }
  }

  /**
   * Close the gripper toward `closed` with a reduced torque limit and report whether something is held.
   * With nothing between the jaws the gripper reaches `closed`; a board stops it early.
   */
  async grip(closed: number, signal?: AbortSignal): Promise<{ held: boolean; position: number }> {
    const id = this.config.gripperId;
    await this.bus.write(id, Reg.torqueLimit, u16le(this.config.gripTorqueLimit));
    await this.bus.write(id, Reg.torqueEnable, [1]);
    await this.bus.write(id, Reg.goalPosition, goalBlock(closed, this.config.approachSpeed));
    let last = await this.bus.position(id);
    let still = 0;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && still < 4) {
      if (signal?.aborted) throw new ArmError("grip stopped");
      await sleep(40);
      const now = await this.bus.position(id);
      still = stepDistance(now, last) <= 2 ? still + 1 : 0;
      last = now;
    }
    return { held: stepDistance(last, closed) >= this.config.gripDetectSteps, position: last };
  }

  async release(open: number, signal?: AbortSignal): Promise<void> {
    const id = this.config.gripperId;
    await this.bus.write(id, Reg.torqueLimit, u16le(1000));
    await this.moveTo({ [id]: open }, { speed: this.config.speed, ...(signal ? { signal } : {}) });
  }
}

export function assertPose(value: unknown, what: string): Pose {
  if (!value || typeof value !== "object") throw new ArmError(`${what} has not been taught yet`);
  const pose = value as Pose;
  for (const [id, position] of Object.entries(pose)) {
    if (!/^\d+$/.test(id) || typeof position !== "number" || position < 0 || position > MAX_POSITION) throw new ArmError(`${what} has an invalid entry for servo ${id}`);
  }
  if (!Object.keys(pose).length) throw new ArmError(`${what} has not been taught yet`);
  return pose;
}

