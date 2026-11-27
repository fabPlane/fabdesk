/**
 * The laser cell as fabdesk-core sees it: one per machine, configured in `<FABDESK_HOME>/laser-cell.json`.
 * Owns the open serial ports, the taught poses and the running batch; tools and the Laser cell
 * workspace talk to it through `snapshot()` and the action methods.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";
import { Arm, DEFAULT_ARM_CONFIG, type JointState, type Pose } from "./arm";
import { CellError, POSE_LABELS, POSE_NAMES, missingPoses, runCycle, type CellPoses, type CycleStep, type LaserDriver, type LaserStatus, type PoseName } from "./cell";
import { LightBurnLaser, SimulatedLaser, StudioFootswitchLaser, openLightBurnUdp, openRelay } from "./lasers";
import { listSerialPorts, openSerial, type SerialPortInfo } from "./serial";
import { DEFAULT_STUDIO_EXE, StudioWindowLaser, launchStudio, windowsStudioUi, type StudioJobSpec, type StudioLoadResult } from "./studio-window";
import { DEFAULT_BAUD, St3215Bus } from "./st3215";

const PoseSchema = z.record(z.string().regex(/^\d+$/), z.number().int().min(0).max(4095));

export const LaserCellConfigSchema = z.object({
  version: z.literal(1).default(1),
  arm: z.object({
    port: z.string().nullable().default(null),
    baud: z.number().int().positive().default(DEFAULT_BAUD),
    jointIds: z.array(z.number().int().min(0).max(253)).min(1).max(12).default(DEFAULT_ARM_CONFIG.jointIds),
    gripperId: z.number().int().min(0).max(253).default(DEFAULT_ARM_CONFIG.gripperId),
    speed: z.number().int().min(50).max(3400).default(DEFAULT_ARM_CONFIG.speed),
    approachSpeed: z.number().int().min(20).max(3400).default(DEFAULT_ARM_CONFIG.approachSpeed),
  }).default({ port: null, baud: DEFAULT_BAUD, jointIds: DEFAULT_ARM_CONFIG.jointIds, gripperId: DEFAULT_ARM_CONFIG.gripperId, speed: DEFAULT_ARM_CONFIG.speed, approachSpeed: DEFAULT_ARM_CONFIG.approachSpeed }),
  laser: z.object({
    driver: z.enum(["studio-footswitch", "studio-window", "lightburn", "simulator"]).default("studio-window"),
    /** studio-window: how fabPlane knows the job ended. watch = Studio's Start button; timer = markSeconds + marginSeconds. */
    studioCompletion: z.enum(["watch", "timer"]).default("watch"),
    /** studio-window: ComMarker_Studio.exe (null = the default install folder). */
    studioExe: z.string().nullable().default(null),
    /** studio-window: where the board's centre sits on Studio's field (the jig), in Studio's X / Y (0,0 = field centre). */
    studioBoardCenterMm: z.object({ x: z.number().min(-200).max(200), y: z.number().min(-200).max(200) }).default({ x: 0, y: 0 }),
    /** lcus = CH340 USB relay board; arduino = Arduino/ESP32 + relay module running docs/laser-cell-footswitch.ino. */
    relayKind: z.enum(["lcus", "arduino"]).default("lcus"),
    relayPort: z.string().nullable().default(null),
    relayChannel: z.number().int().min(1).max(8).default(1),
    /** Studio route: the job's marking time, read from Studio's estimate or timed on the first board. */
    markSeconds: z.number().min(1).max(4 * 3600).default(600),
    marginSeconds: z.number().min(0).max(600).default(5),
    /** LightBurn route: the job file loaded before each board (absolute path). */
    jobPath: z.string().nullable().default(null),
    lightburnHost: z.string().default("127.0.0.1"),
    frameSeconds: z.number().min(0).max(60).default(0),
    markTimeoutMinutes: z.number().min(1).max(600).default(120),
  }).default({ driver: "studio-window", studioCompletion: "watch", studioExe: null, studioBoardCenterMm: { x: 0, y: 0 }, relayKind: "lcus", relayPort: null, relayChannel: 1, markSeconds: 600, marginSeconds: 5, jobPath: null, lightburnHost: "127.0.0.1", frameSeconds: 0, markTimeoutMinutes: 120 }),
  poses: z.object({
    home: PoseSchema.optional(),
    stackAbove: PoseSchema.optional(),
    stackPick: PoseSchema.optional(),
    jigAbove: PoseSchema.optional(),
    jigPlace: PoseSchema.optional(),
    clear: PoseSchema.optional(),
    trayAbove: PoseSchema.optional(),
    trayPlace: PoseSchema.optional(),
    gripperOpen: z.number().int().min(0).max(4095).optional(),
    gripperClosed: z.number().int().min(0).max(4095).optional(),
  }).default({}),
  /**
   * The Omni X stops when its lid opens, so an arm that reaches the bed needs the lid open or the
   * cover sensor off. Either way the 355 nm UV is no longer contained; the operator must confirm a
   * UV-blocking guard around the whole cell before an automatic run.
   */
  safetyConfirmed: z.boolean().default(false),
});
export type LaserCellConfig = z.infer<typeof LaserCellConfigSchema>;

export type CellLogEntry = { at: string; level: "info" | "warn" | "error"; message: string };

export type CellSnapshot = {
  config: LaserCellConfig;
  configPath: string;
  arm: { connected: boolean; port: string | null; joints: JointState[] | null; error: string | null };
  laser: LaserStatus | null;
  poses: Array<{ name: PoseName; label: string; taught: boolean }>;
  missing: string[];
  run: {
    active: boolean;
    mode: "cycle" | "dry-run" | "laser-only" | null;
    step: CycleStep | null;
    /** Steps the current board has been through, in order (skipped ones are absent). */
    visited: CycleStep[];
    note: string | null;
    progress: number;
    board: number;
    boards: number;
    done: number;
    startedAt: string | null;
    error: string | null;
  };
  log: CellLogEntry[];
};

export type RunRequest = { boards: number; mode: "cycle" | "dry-run" | "laser-only" };

export class LaserCellError extends Error {
  override name = "LaserCellError";
}

export type ControllerDeps = {
  home: string;
  listPorts?: () => Promise<SerialPortInfo[]>;
  openArmBus?: (port: string, baud: number) => Promise<St3215Bus>;
  makeLaser?: (config: LaserCellConfig) => Promise<LaserDriver>;
};

export class LaserCellController {
  readonly configPath: string;
  private config: LaserCellConfig = LaserCellConfigSchema.parse({});
  private loaded = false;
  private arm: Arm | null = null;
  private armError: string | null = null;
  private laser: LaserDriver | null = null;
  private laserKey = "";
  private abort: AbortController | null = null;
  private runState: CellSnapshot["run"] = { active: false, mode: null, step: null, visited: [], note: null, progress: 0, board: 0, boards: 0, done: 0, startedAt: null, error: null };
  private logEntries: CellLogEntry[] = [];
  private running: Promise<void> | null = null;

  constructor(private readonly deps: ControllerDeps) {
    this.configPath = join(deps.home, "laser-cell.json");
  }

  // ------------------------------------------------------------ config

  async load(): Promise<LaserCellConfig> {
    if (this.loaded) return this.config;
    try {
      this.config = LaserCellConfigSchema.parse(JSON.parse(await readFile(this.configPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.log("warn", `laser-cell.json could not be read (${error instanceof Error ? error.message : String(error)}); using defaults`);
    }
    this.loaded = true;
    return this.config;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const tmp = `${this.configPath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.config, null, 2));
    await rename(tmp, this.configPath);
  }

  async configure(patch: { arm?: Partial<LaserCellConfig["arm"]>; laser?: Partial<LaserCellConfig["laser"]>; safetyConfirmed?: boolean }): Promise<LaserCellConfig> {
    await this.load();
    this.assertIdle();
    const next = LaserCellConfigSchema.parse({
      ...this.config,
      arm: { ...this.config.arm, ...patch.arm },
      laser: { ...this.config.laser, ...patch.laser },
      ...(patch.safetyConfirmed === undefined ? {} : { safetyConfirmed: patch.safetyConfirmed }),
    });
    const armChanged = JSON.stringify(next.arm) !== JSON.stringify(this.config.arm);
    this.config = next;
    await this.save();
    if (armChanged && this.arm) await this.disconnectArm();
    return this.config;
  }

  // ------------------------------------------------------------ logging

  private log(level: CellLogEntry["level"], message: string): void {
    this.logEntries.push({ at: new Date().toISOString(), level, message });
    if (this.logEntries.length > 200) this.logEntries.splice(0, this.logEntries.length - 200);
  }

  // ------------------------------------------------------------ connections

  listPorts(): Promise<SerialPortInfo[]> {
    return (this.deps.listPorts ?? listSerialPorts)();
  }

  async connectArm(): Promise<void> {
    await this.load();
    if (this.arm) return;
    const { port, baud, jointIds, gripperId, speed, approachSpeed } = this.config.arm;
    if (!port) throw new LaserCellError("Choose the arm's servo-board port first");
    try {
      const bus = await (this.deps.openArmBus ?? (async (p, b) => new St3215Bus(await openSerial(p, b))))(port, baud);
      const arm = new Arm(bus, { ...DEFAULT_ARM_CONFIG, jointIds, gripperId, speed, approachSpeed });
      const missing = await arm.missing();
      if (missing.length === arm.allIds.length) {
        await bus.close();
        throw new LaserCellError(`No servo answered on ${port}. Check the 12 V supply, the servo cable and that this is the servo board's port.`);
      }
      if (missing.length) this.log("warn", `servo ${missing.join(", ")} did not answer on ${port}`);
      this.arm = arm;
      this.armError = null;
      this.log("info", `arm connected on ${port}`);
    } catch (error) {
      this.armError = error instanceof Error ? error.message : String(error);
      throw error instanceof LaserCellError ? error : new LaserCellError(this.armError);
    }
  }

  async disconnectArm(): Promise<void> {
    this.assertIdle();
    const arm = this.arm;
    this.arm = null;
    if (arm) await arm.bus.close().catch(() => undefined);
  }

  private requireArm(): Arm {
    if (!this.arm) throw new LaserCellError("Connect the arm first");
    return this.arm;
  }

  private async laserDriver(): Promise<LaserDriver> {
    await this.load();
    const l = this.config.laser;
    const key = JSON.stringify(l);
    if (this.laser && this.laserKey === key) return this.laser;
    await this.laser?.close?.().catch(() => undefined);
    this.laser = null;
    if (this.deps.makeLaser) this.laser = await this.deps.makeLaser(this.config);
    else if (l.driver === "simulator") this.laser = new SimulatedLaser();
    else if (l.driver === "lightburn") this.laser = new LightBurnLaser(await openLightBurnUdp(l.lightburnHost));
    else if (l.driver === "studio-window") this.laser = new StudioWindowLaser(windowsStudioUi(), { completion: l.studioCompletion, markSeconds: l.markSeconds, marginSeconds: l.marginSeconds });
    else {
      if (!l.relayPort) throw new LaserCellError("Choose the USB relay's port (the relay wired to the Omni X foot-switch input)");
      this.laser = new StudioFootswitchLaser({ relay: await openRelay(l.relayKind, l.relayPort, l.relayChannel), markSeconds: l.markSeconds, marginSeconds: l.marginSeconds });
    }
    this.laserKey = key;
    return this.laser;
  }

  // ------------------------------------------------------------ teaching

  async relax(): Promise<void> {
    this.assertIdle();
    await this.requireArm().relax();
    this.log("info", "arm relaxed for teaching; support it by hand");
  }

  async hold(): Promise<void> {
    this.assertIdle();
    await this.requireArm().hold();
  }

  async teach(name: PoseName | "gripperOpen" | "gripperClosed"): Promise<Pose | number> {
    this.assertIdle();
    await this.load();
    const arm = this.requireArm();
    const pose = await arm.read();
    const poses = this.config.poses as CellPoses;
    let taught: Pose | number;
    if (name === "gripperOpen" || name === "gripperClosed") {
      taught = pose[arm.config.gripperId]!;
      poses[name] = taught;
    } else {
      // The gripper is driven separately (grip / release); keep it out of travel poses.
      const { [String(arm.config.gripperId)]: _gripper, ...joints } = pose;
      taught = joints;
      poses[name] = joints;
    }
    this.config = LaserCellConfigSchema.parse({ ...this.config, poses });
    await this.save();
    this.log("info", `taught ${name === "gripperOpen" ? "gripper open" : name === "gripperClosed" ? "gripper closed" : POSE_LABELS[name]}`);
    return taught;
  }

  /**
   * Drive the foot-switch relay by hand: press = one short click (starts one job in Studio),
   * hold / release = keep the pedal down or let it up. Only on the ComMarker Studio route, never during a run.
   */
  async footswitch(action: "press" | "hold" | "release"): Promise<boolean> {
    await this.load();
    if (action !== "release") this.assertIdle();
    if (this.config.laser.driver !== "studio-footswitch") throw new LaserCellError("The foot switch is only used on the ComMarker Studio route");
    const laser = await this.laserDriver();
    if (!(laser instanceof StudioFootswitchLaser)) throw new LaserCellError("The foot-switch relay is not available");
    if (action === "press") await laser.relay.pulse(250);
    else await laser.relay.set(action === "hold");
    this.log(action === "release" ? "info" : "warn", action === "press" ? "foot switch pressed once from fabPlane" : action === "hold" ? "foot switch held down from fabPlane" : "foot switch released");
    return laser.relay.pressed;
  }

  /** Starts ComMarker Studio without admin rights (studio-window route); no-op when it is already open. */
  async openStudio(): Promise<"running" | "started"> {
    await this.load();
    if (this.config.laser.driver !== "studio-window") throw new LaserCellError("Choose \"ComMarker Studio (fabPlane presses Start in Studio)\" as the laser route first");
    const laser = await this.laserDriver();
    if (!(laser instanceof StudioWindowLaser)) throw new LaserCellError("The Studio window driver is not available");
    const result = await launchStudio(laser.ui, this.config.laser.studioExe ?? DEFAULT_STUDIO_EXE);
    if (result === "started") this.log("info", "started ComMarker Studio");
    return result;
  }

  /**
   * Builds a job in ComMarker Studio (studio-window route): starts Studio if needed, imports the file, sets its
   * true size and place, the hatch fill and the laser settings, and reports what Studio shows afterwards.
   */
  async studioLoadJob(spec: StudioJobSpec): Promise<StudioLoadResult> {
    await this.load();
    this.assertIdle();
    if (this.config.laser.driver !== "studio-window") throw new LaserCellError("Choose \"ComMarker Studio (fabPlane presses Start in Studio)\" as the laser route first");
    const laser = await this.laserDriver();
    if (!(laser instanceof StudioWindowLaser)) throw new LaserCellError("The Studio window driver is not available");
    if ((await launchStudio(laser.ui, this.config.laser.studioExe ?? DEFAULT_STUDIO_EXE)) === "started") this.log("info", "started ComMarker Studio");
    const result = await laser.loadJob(spec);
    for (const line of result.log) this.log(/check in Studio|no Power|not found|greyed/.test(line) ? "warn" : "info", `Studio: ${line}`);
    return result;
  }

  async moveTo(name: PoseName): Promise<void> {
    this.assertIdle();
    await this.load();
    const pose = (this.config.poses as CellPoses)[name];
    if (!pose) throw new LaserCellError(`${POSE_LABELS[name]} has not been taught yet`);
    const arm = this.requireArm();
    await arm.prepare();
    await arm.moveTo(pose, { speed: this.config.arm.approachSpeed });
  }

  // ------------------------------------------------------------ running

  private assertIdle(): void {
    if (this.runState.active) throw new LaserCellError("The cell is running; stop it first");
  }

  async run(request: RunRequest): Promise<void> {
    await this.load();
    this.assertIdle();
    const boards = Math.max(1, Math.min(500, Math.round(request.boards)));
    if (request.mode !== "dry-run" && !this.config.safetyConfirmed) {
      throw new LaserCellError("Confirm the UV safety guard first: with the lid open or the cover sensor off, the Omni X's 355 nm beam is no longer enclosed");
    }
    const missing = missingPoses(this.config.poses as CellPoses, request.mode === "laser-only");
    if (missing.length) throw new LaserCellError(`Teach these positions first: ${missing.join(", ")}`);
    if (request.mode !== "laser-only") this.requireArm();
    const laser = request.mode === "dry-run" ? new SimulatedLaser(0) : await this.laserDriver();
    if (this.config.laser.driver === "lightburn" && request.mode !== "dry-run") {
      if (!this.config.laser.jobPath) throw new LaserCellError("Choose the LightBurn job file first");
      await laser.load?.(this.config.laser.jobPath);
    }
    const controller = new AbortController();
    this.abort = controller;
    this.runState = { active: true, mode: request.mode, step: "preflight", visited: [], note: null, progress: 0, board: 0, boards, done: 0, startedAt: new Date().toISOString(), error: null };
    this.log("info", `${request.mode} started for ${boards} board(s) with ${laser.name}`);
    this.running = (async () => {
      try {
        for (let board = 1; board <= boards; board++) {
          this.runState.board = board;
          this.runState.visited = [];
          try {
            await runCycle(request.mode === "laser-only" ? null : this.arm, laser, this.config.poses as CellPoses, {
              frameSeconds: this.config.laser.frameSeconds,
              markTimeoutMs: this.config.laser.markTimeoutMinutes * 60_000,
              laserOnly: request.mode === "laser-only",
              dryRun: request.mode === "dry-run",
              signal: controller.signal,
              onEvent: event => {
                if (event.type === "step") { this.runState.step = event.step; this.runState.visited = [...this.runState.visited, event.step]; this.runState.note = event.note; this.runState.progress = 0; this.log("info", `board ${board}: ${event.note}`); }
                else if (event.type === "progress") this.runState.progress = event.fraction;
                else this.log("warn", `board ${board}: ${event.message}`);
              },
            });
            this.runState.done = board;
          } catch (error) {
            if (error instanceof CellError && error.step === "pick" && /No board in the gripper/.test(error.message) && board > 1) {
              this.log("info", `stack empty after ${board - 1} board(s)`);
              break;
            }
            throw error;
          }
        }
        this.log("info", `finished ${this.runState.done} of ${boards} board(s)`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.runState.error = message;
        this.log("error", message);
        if (this.config.laser.driver === "studio-window") this.log("warn", "fabPlane pressed Stop in ComMarker Studio if it showed one; check the Omni X has stopped and use its E-stop if not");
        else if (this.config.laser.driver !== "simulator") this.log("warn", "fabPlane cannot stop the beam remotely on this laser route; press the Omni X E-stop if it is still marking");
      } finally {
        this.runState.active = false;
        this.abort = null;
      }
    })();
  }

  /** Stop now: abort the sequence, stop the laser where the route allows it, freeze the arm. */
  async stop(): Promise<void> {
    if (!this.abort) return;
    this.log("warn", "stop requested");
    this.abort.abort();
    await this.laser?.stop().catch(() => undefined);
    await this.arm?.stop();
    await this.running?.catch(() => undefined);
  }

  /** Wait for the current run (tests). */
  async settled(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  async snapshot(options: { probe?: boolean } = {}): Promise<CellSnapshot> {
    await this.load();
    let joints: JointState[] | null = null;
    if (this.arm && options.probe !== false && !this.runState.active) {
      try {
        joints = await this.arm.states();
        this.armError = null;
      } catch (error) {
        this.armError = error instanceof Error ? error.message : String(error);
      }
    }
    let laser: LaserStatus | null = null;
    if (options.probe !== false && !this.runState.active) {
      try {
        laser = await (await this.laserDriver()).status();
      } catch (error) {
        laser = { state: "offline", detail: error instanceof Error ? error.message : String(error), driver: this.config.laser.driver };
      }
    }
    const poses = this.config.poses as CellPoses;
    return {
      config: this.config,
      configPath: this.configPath,
      arm: { connected: !!this.arm, port: this.config.arm.port, joints, error: this.armError },
      laser,
      poses: POSE_NAMES.map(name => ({ name, label: POSE_LABELS[name], taught: !!poses[name] && Object.keys(poses[name]!).length > 0 })),
      missing: missingPoses(poses),
      run: { ...this.runState, visited: [...this.runState.visited] },
      log: this.logEntries.slice(-60),
    };
  }

  async dispose(): Promise<void> {
    await this.stop();
    await this.arm?.bus.close().catch(() => undefined);
    await this.laser?.close?.().catch(() => undefined);
    this.arm = null;
    this.laser = null;
  }
}
