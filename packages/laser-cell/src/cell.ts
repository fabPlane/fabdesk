/**
 * One laser-cell cycle: pick a copper blank, place it in the laser jig, clear the arm, run the
 * laser, wait for it to finish, unload the board to the output tray.
 *
 * The laser is behind `LaserDriver` so the same sequence works with ComMarker Studio / EZCAD
 * (foot-switch trigger + window automation), LightBurn (UDP) or a simulator.
 */
import { Arm, assertPose, type Pose, poseReached } from "./arm";

export type LaserState = "idle" | "busy" | "error" | "offline";

export type LaserStatus = { state: LaserState; detail: string; driver: string };

export interface LaserDriver {
  readonly name: string;
  status(): Promise<LaserStatus>;
  /** Load the job so the next start runs it. Optional when the operator loads it in the laser app. */
  load?(jobPath: string): Promise<void>;
  /** Red-light preview of the job outline (used to check placement). */
  frame?(seconds: number, signal?: AbortSignal): Promise<void>;
  /** Start marking. Resolves once the laser has accepted the start, not when it finishes. */
  start(): Promise<void>;
  /** Resolve when marking finishes; reject on error, timeout or abort. */
  waitDone(options: { timeoutMs: number; signal?: AbortSignal }): Promise<void>;
  /** Stop marking as soon as possible. Must be safe to call at any time. */
  stop(): Promise<void>;
  close?(): Promise<void>;
  /**
   * Set by drivers that cannot see the job finish and wait a fixed time instead. Checked against the time
   * limit before the laser starts, never after.
   */
  readonly expectedSeconds?: number | undefined;
}

/** Taught stations. Each "above" pose is the same spot lifted ~30 mm, used for straight approaches. */
export type CellPoses = {
  home?: Pose;
  stackAbove?: Pose;
  stackPick?: Pose;
  jigAbove?: Pose;
  jigPlace?: Pose;
  /** Arm parked fully outside the laser's work area and light path. The laser only starts from here. */
  clear?: Pose;
  trayAbove?: Pose;
  trayPlace?: Pose;
  gripperOpen?: number;
  gripperClosed?: number;
};

export const POSE_NAMES = ["home", "stackAbove", "stackPick", "jigAbove", "jigPlace", "clear", "trayAbove", "trayPlace"] as const;
export type PoseName = (typeof POSE_NAMES)[number];

export const POSE_LABELS: Record<PoseName, string> = {
  home: "Home",
  stackAbove: "Above blank stack",
  stackPick: "Pick from stack",
  jigAbove: "Above laser jig",
  jigPlace: "In laser jig",
  clear: "Clear of laser",
  trayAbove: "Above output tray",
  trayPlace: "Drop in output tray",
};

export type CycleStep =
  | "preflight"
  | "pick"
  | "place"
  | "clear"
  | "frame"
  | "mark"
  | "unload"
  | "done";

export type CycleEvent =
  | { type: "step"; step: CycleStep; note: string }
  | { type: "progress"; step: CycleStep; fraction: number }
  | { type: "warning"; message: string };

export type CycleOptions = {
  /** Run the red-light frame for this many seconds before marking (0 = skip). */
  frameSeconds: number;
  /** Abort marking when it runs longer than this. */
  markTimeoutMs: number;
  /** Skip the pick / place / unload moves (laser-only test). */
  laserOnly?: boolean;
  /** Move the arm through the cycle without firing the laser (dry run). */
  dryRun?: boolean;
  signal?: AbortSignal;
  onEvent?: (event: CycleEvent) => void;
};

export class CellError extends Error {
  override name = "CellError";
  constructor(message: string, readonly step: CycleStep) {
    super(message);
  }
}

export function missingPoses(poses: CellPoses, laserOnly = false): string[] {
  const needed: PoseName[] = laserOnly ? [] : [...POSE_NAMES];
  const missing: string[] = needed.filter(name => !poses[name] || !Object.keys(poses[name]!).length).map(name => POSE_LABELS[name]);
  if (!laserOnly && poses.gripperOpen === undefined) missing.push("Gripper open");
  if (!laserOnly && poses.gripperClosed === undefined) missing.push("Gripper closed (empty)");
  return missing;
}

/** Run one complete cycle. On any failure or stop the laser is stopped and the arm frozen in place. */
export async function runCycle(arm: Arm | null, laser: LaserDriver, poses: CellPoses, options: CycleOptions): Promise<void> {
  const emit = (event: CycleEvent) => options.onEvent?.(event);
  const signal = options.signal;
  let step: CycleStep = "preflight";
  const enter = (next: CycleStep, note: string) => {
    if (signal?.aborted) throw new CellError("Stopped by operator", step);
    step = next;
    emit({ type: "step", step, note });
  };
  const move = (name: PoseName, slow = false) =>
    arm!.moveTo(assertPose(poses[name], POSE_LABELS[name]), {
      ...(slow ? { speed: arm!.config.approachSpeed } : {}),
      ...(signal ? { signal } : {}),
      onProgress: fraction => emit({ type: "progress", step, fraction }),
    });

  try {
    enter("preflight", "Checking laser and arm");
    const missing = missingPoses(poses, options.laserOnly);
    if (missing.length) throw new CellError(`Teach these positions first: ${missing.join(", ")}`, step);
    if (!options.laserOnly) {
      if (!arm) throw new CellError("Arm is not connected", step);
      const absent = await arm.missing();
      if (absent.length) throw new CellError(`Servo ${absent.join(", ")} did not answer. Check the servo cable and the 12 V supply.`, step);
      const hot = (await arm.states()).filter(joint => joint.temperature >= 60);
      if (hot.length) throw new CellError(`Servo ${hot.map(j => `${j.id} (${j.temperature} °C)`).join(", ")} is too hot; let the arm cool down`, step);
      await arm.prepare();
    }
    if (options.laserOnly && arm) {
      // A connected arm must be parked out of the beam before a laser-only run.
      const clear = poses.clear;
      if (!clear || !Object.keys(clear).length) throw new CellError("The arm is connected: teach “Clear of laser” (or disconnect the arm) before a laser-only run", step);
      if (!poseReached(clear, await arm.read(), arm.config.toleranceSteps * 3)) {
        throw new CellError("The arm is not at “Clear of laser”: move it there (Arm setup → Go) before a laser-only run", step);
      }
    }
    if (!options.dryRun) {
      if (laser.expectedSeconds !== undefined && laser.expectedSeconds * 1000 > options.markTimeoutMs) {
        throw new CellError(`The job time (${Math.round(laser.expectedSeconds)} s) is longer than the time limit (${Math.round(options.markTimeoutMs / 1000)} s); raise “Give up after” in Settings`, step);
      }
      const status = await laser.status();
      if (status.state !== "idle") throw new CellError(`Laser is not ready (${status.state}: ${status.detail})`, step);
    }

    if (!options.laserOnly) {
      const a = arm!;
      enter("pick", "Picking a copper blank from the stack");
      await move("home");
      await a.release(poses.gripperOpen!, signal);
      await move("stackAbove");
      await move("stackPick", true);
      const grip = await a.grip(poses.gripperClosed!, signal);
      if (!grip.held) {
        await move("stackAbove");
        throw new CellError("No board in the gripper: the stack is empty or the pick position is off", step);
      }
      await move("stackAbove", true);

      enter("place", "Placing the blank in the laser jig");
      await move("jigAbove");
      await move("jigPlace", true);
      await a.release(poses.gripperOpen!, signal);
      await move("jigAbove", true);

      enter("clear", "Moving the arm out of the laser area");
      await move("clear");
    }

    if (!options.dryRun) {
      if (options.frameSeconds > 0 && laser.frame) {
        enter("frame", "Red-light frame to check the board position");
        await laser.frame(options.frameSeconds, signal);
      }
      enter("mark", "Laser running");
      await laser.start();
      // A stop that arrived while the laser was being started: stop it now (the catch below does).
      if (signal?.aborted) throw new CellError("Stopped by operator", step);
      await laser.waitDone({ timeoutMs: options.markTimeoutMs, ...(signal ? { signal } : {}) });
    }

    if (!options.laserOnly) {
      const a = arm!;
      enter("unload", "Moving the finished board to the output tray");
      await move("jigAbove");
      await move("jigPlace", true);
      const grip = await a.grip(poses.gripperClosed!, signal);
      if (!grip.held) emit({ type: "warning", message: "Did not feel the board in the jig; it may have moved during marking" });
      await move("jigAbove", true);
      await move("trayAbove");
      await move("trayPlace", true);
      await a.release(poses.gripperOpen!, signal);
      await move("trayAbove", true);
      await move("home");
    }
    enter("done", "Cycle finished");
  } catch (error) {
    await laser.stop().catch(() => undefined);
    await arm?.stop();
    if (error instanceof CellError) throw error;
    const message = signal?.aborted ? "Stopped by operator" : error instanceof Error ? error.message : String(error);
    throw new CellError(message, step);
  }
}

