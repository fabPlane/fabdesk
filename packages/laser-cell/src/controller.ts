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
import { LmcLaser } from "./lmc/laser";
import { findLasers, type LaserFinding } from "./lmc/discover";
import { importArt, type ArtFormat } from "./art";
import { validateSettings } from "./lmc/job";
import { DEFAULT_TIMING, LmcJobFileSchema, MATERIAL_PRESETS, artToJob, jobStem, jobView, readJob, writeJob, type EdgeSettings, type JobSettings, type JobView, type LmcJob } from "./lmc/job-file";
import { listUsbDevices, openUsbLmc, LMC_PID, LMC_VID } from "./lmc/usb";
import { BRIDGE_DEFAULT_PORT, openBridgeLmc } from "./lmc/bridge";
import { DEFAULT_STUDIO_EXE, StudioWindowLaser, launchStudio, windowsStudioUi, type StudioJobSpec, type StudioLoadResult } from "./studio-window";
import { DEFAULT_BAUD, St3215Bus } from "./st3215";

const PoseSchema = z.record(z.string().regex(/^\d+$/), z.number().int().min(0).max(4095));

/** How long a laser status check is reused (ms). */
const STATUS_CACHE_MS = 4000;

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
    driver: z.enum(["studio-footswitch", "studio-window", "lightburn", "usb-lmc", "simulator"]).default("studio-window"),
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
    markSeconds: z.number().min(1).max(24 * 3600).default(600),
    marginSeconds: z.number().min(0).max(600).default(5),
    /** LightBurn route: the job file loaded before each board (absolute path). */
    jobPath: z.string().nullable().default(null),
    lightburnHost: z.string().default("127.0.0.1"),
    frameSeconds: z.number().min(0).max(60).default(0),
    markTimeoutMinutes: z.number().min(1).max(24 * 60).default(120),
    /** usb-lmc: fabPlane's own USB driver for BJJCZ boards. Unverified on the Omni X: pins, source and axes are guesses. */
    lmc: z.object({
      fieldMm: z.number().min(10).max(400).default(70),
      centerMm: z.object({ x: z.number().min(-200).max(200), y: z.number().min(-200).max(200) }).default({ x: 0, y: 0 }),
      flipX: z.boolean().default(false),
      flipY: z.boolean().default(false),
      swapXY: z.boolean().default(false),
      source: z.enum(["co2", "fiber"]).default("co2"),
      laserPin: z.number().int().min(0).max(15).default(0),
      lightPin: z.number().int().min(0).max(15).default(8),
      /** Hard power cap for every mark; starts low until the machine has been tested. */
      maxPowerPct: z.number().min(1).max(100).default(20),
      initBoard: z.boolean().default(true),
      usbIndex: z.number().int().min(0).max(8).default(0),
      /** usb = laser cable in this computer; network = a fabPlane laser bridge on the Wi-Fi. */
      connection: z.enum(["usb", "network"]).default("usb"),
      host: z.string().default(""),
      port: z.number().int().min(1).max(65535).default(BRIDGE_DEFAULT_PORT),
      token: z.string().default(""),
    }).default({ fieldMm: 70, centerMm: { x: 0, y: 0 }, flipX: false, flipY: false, swapXY: false, source: "co2", laserPin: 0, lightPin: 8, maxPowerPct: 20, initBoard: true, usbIndex: 0, connection: "usb", host: "", port: BRIDGE_DEFAULT_PORT, token: "" }),
  }).default({ driver: "studio-window", studioCompletion: "watch", studioExe: null, studioBoardCenterMm: { x: 0, y: 0 }, relayKind: "lcus", relayPort: null, relayChannel: 1, markSeconds: 600, marginSeconds: 5, jobPath: null, lightburnHost: "127.0.0.1", frameSeconds: 0, markTimeoutMinutes: 120, lmc: { fieldMm: 70, centerMm: { x: 0, y: 0 }, flipX: false, flipY: false, swapXY: false, source: "co2", laserPin: 0, lightPin: 8, maxPowerPct: 20, initBoard: true, usbIndex: 0, connection: "usb", host: "", port: BRIDGE_DEFAULT_PORT, token: "" } }),
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
    /** fabPlane USB / Wi-Fi driver: the job is paused (Resume continues it). */
    paused?: boolean;
    /** Estimated seconds left of the laser job being marked, when the driver knows. */
    remainingSeconds?: number | null;
    /** Pause can work right now (a job is being marked by fabPlane's own driver and no stop is under way). */
    pausable?: boolean;
  };
  log: CellLogEntry[];
  /** A non-run operation in progress (loading into Studio, preview, arm move); Stop ends it. */
  operation: string | null;
};

/** Shown in snapshots instead of the Wi-Fi bridge's access key; sending it back keeps the saved key. */
export const SAVED_SECRET = "__saved__";

export type RunRequest = { boards: number; mode: "cycle" | "dry-run" | "laser-only" };

export class LaserCellError extends Error {
  override name = "LaserCellError";
}

export type ControllerDeps = {
  home: string;
  listPorts?: () => Promise<SerialPortInfo[]>;
  openArmBus?: (port: string, baud: number) => Promise<St3215Bus>;
  makeLaser?: (config: LaserCellConfig) => Promise<LaserDriver>;
  /** Opens the foot-switch relay (tests: a fake relay). */
  openRelay?: typeof openRelay;
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
  /** The one non-run operation allowed at a time; Stop aborts it. */
  private operation: { kind: string; abort: AbortController; done: Promise<unknown> } | null = null;

  /** Until when the laser may still be marking a job fabPlane cannot see (foot-switch route); kept on disk. */
  private laserBusyUntil = 0;
  private readonly busyPath: string;

  constructor(private readonly deps: ControllerDeps) {
    this.configPath = join(deps.home, "laser-cell.json");
    this.busyPath = join(deps.home, "laser-cell.busy.json");
  }

  /** Writes of laser-cell.busy.json, in order; dispose() waits for them. */
  private busyWrites: Promise<void> = Promise.resolve();
  /** Bumped by every stop(); an action that started before a stop does not go on to press anything. */
  private stops = 0;
  /** One laser driver build at a time (two overlapping builds would open the port twice). */
  private driverBuild: Promise<LaserDriver> | null = null;

  private noteBusyUntil(until: number) {
    this.laserBusyUntil = Math.max(this.laserBusyUntil, until);
    const value = this.laserBusyUntil;
    this.busyWrites = this.busyWrites.then(async () => {
      const tmp = `${this.busyPath}.tmp`;
      await writeFile(tmp, JSON.stringify({ until: value }));
      await rename(tmp, this.busyPath);
    }).catch(error => this.log("warn", `could not save the laser busy time (${error instanceof Error ? error.message : String(error)})`));
  }

  // ------------------------------------------------------------ config

  async load(): Promise<LaserCellConfig> {
    if (this.loaded) return this.config;
    let text: string | null = null;
    for (let attempt = 0; ; attempt++) {
      try {
        text = await readFile(this.configPath, "utf8");
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") break;
        // Locked or unreadable for now (antivirus, sync tool, editor): retry, then fail without loading
        // defaults, so the next save can never overwrite the taught positions.
        if (attempt >= 4) throw new LaserCellError(`laser-cell.json could not be read (${code ?? (error instanceof Error ? error.message : String(error))}); close any program using it and try again`);
        await new Promise(r => setTimeout(r, 250));
      }
    }
    if (text !== null) {
      try {
        this.config = LaserCellConfigSchema.parse(JSON.parse(text.replace(/^\uFEFF/, ""))); // editors and PowerShell 5.1 add a BOM
      } catch (error) {
        // Damaged content: set the file aside (taught positions can be recovered from it), then start fresh.
        const kept = this.configPath.replace(/\.json$/, `.unreadable-${Date.now()}.json`);
        try {
          await rename(this.configPath, kept);
        } catch {
          throw new LaserCellError(`laser-cell.json is damaged and could not be set aside; move or fix ${this.configPath} and try again`);
        }
        this.log("warn", `laser-cell.json could not be read (${error instanceof Error ? error.message : String(error)}); kept it as ${kept} and started from defaults`);
      }
    }
    try {
      const busy = JSON.parse(await readFile(this.busyPath, "utf8")) as { until?: unknown };
      if (typeof busy.until === "number") this.laserBusyUntil = busy.until;
    } catch { /* none */ }
    // The UV-guard confirmation is about the cell as it is now: it never carries over from an earlier session.
    this.config = { ...this.config, safetyConfirmed: false };
    this.loaded = true;
    return this.config;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.configPath), { recursive: true });
    const tmp = `${this.configPath}.tmp`;
    await writeFile(tmp, JSON.stringify(this.config, null, 2));
    await rename(tmp, this.configPath);
  }

  async configure(patch: { arm?: Partial<LaserCellConfig["arm"]>; laser?: Partial<Omit<LaserCellConfig["laser"], "lmc">> & { lmc?: { [K in keyof LaserCellConfig["laser"]["lmc"]]?: LaserCellConfig["laser"]["lmc"][K] | undefined } }; safetyConfirmed?: boolean }): Promise<LaserCellConfig> {
    await this.load();
    this.assertIdle();
    const { lmc, ...laserPatch } = patch.laser ?? {};
    const lmcPatch = Object.fromEntries(Object.entries(lmc ?? {}).filter(([k, v]) => v !== undefined && !(k === "token" && v === SAVED_SECRET)));
    const parsed = LaserCellConfigSchema.safeParse({
      ...this.config,
      arm: { ...this.config.arm, ...patch.arm },
      laser: { ...this.config.laser, ...laserPatch, lmc: { ...this.config.laser.lmc, ...lmcPatch } },
      ...(patch.safetyConfirmed === undefined ? {} : { safetyConfirmed: patch.safetyConfirmed }),
    });
    if (!parsed.success) {
      throw new LaserCellError(`Settings not saved: ${parsed.error.issues.map(i => `${i.path.join(".") || "value"}: ${i.message}`).join("; ")}`);
    }
    const next = parsed.data;
    // A different laser route, or another laser (USB board, bridge address), is a different cell: the UV-guard
    // confirmation has to be given again.
    const which = (c: LaserCellConfig) => JSON.stringify([c.laser.driver, c.laser.lmc.connection, c.laser.lmc.host, c.laser.lmc.port, c.laser.lmc.usbIndex]);
    if (which(next) !== which(this.config) && patch.safetyConfirmed === undefined) next.safetyConfirmed = false;
    const armChanged = JSON.stringify(next.arm) !== JSON.stringify(this.config.arm);
    this.config = next;
    await this.save();
    if (armChanged && this.arm) await this.disconnectArm();
    return this.publicConfig();
  }

  /** The config as shown outside the core: the bridge access key replaced by a placeholder. */
  private publicConfig(): LaserCellConfig {
    const lmc = this.config.laser.lmc;
    return { ...this.config, laser: { ...this.config.laser, lmc: { ...lmc, token: lmc.token ? SAVED_SECRET : "" } } };
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
    while (this.driverBuild) await this.driverBuild.catch(() => undefined);
    const build = this.buildLaserDriver();
    this.driverBuild = build;
    try {
      return await build;
    } finally {
      if (this.driverBuild === build) this.driverBuild = null;
    }
  }

  private async buildLaserDriver(): Promise<LaserDriver> {
    await this.load();
    const l = this.config.laser;
    const key = JSON.stringify(l);
    if (this.laser && this.laserKey === key) return this.laser;
    await this.laser?.close?.().catch(() => undefined);
    this.laser = null;
    if (this.deps.makeLaser) this.laser = await this.deps.makeLaser(this.config);
    else if (l.driver === "simulator") this.laser = new SimulatedLaser();
    else if (l.driver === "lightburn") this.laser = new LightBurnLaser(await openLightBurnUdp(l.lightburnHost));
    else if (l.driver === "usb-lmc") {
      const m = l.lmc;
      const open = m.connection === "network"
        ? () => {
          if (!m.host || !m.token) throw new LaserCellError("Enter the laser bridge's address and access key (shown in the bridge window)");
          return openBridgeLmc(m.host, m.port, m.token);
        }
        : () => openUsbLmc(m.usbIndex);
      this.laser = new LmcLaser(open, {
        field: { sizeMm: m.fieldMm, centerMm: [m.centerMm.x, m.centerMm.y], flipX: m.flipX, flipY: m.flipY, swapXY: m.swapXY },
        source: m.source, pins: { laser: m.laserPin, light: m.lightPin }, maxPowerPct: m.maxPowerPct, initBoard: m.initBoard, frameSeconds: Math.max(2, l.frameSeconds), link: m.connection === "network" ? `the Wi-Fi bridge (${m.host})` : "USB",
      });
    }
    else if (l.driver === "studio-window") this.laser = new StudioWindowLaser(windowsStudioUi(), { completion: l.studioCompletion, markSeconds: l.markSeconds, marginSeconds: l.marginSeconds });
    else {
      if (!l.relayPort) throw new LaserCellError("Choose the USB relay's port (the relay wired to the Omni X foot-switch input)");
      this.laser = new StudioFootswitchLaser({
        relay: await (this.deps.openRelay ?? openRelay)(l.relayKind, l.relayPort, l.relayChannel), markSeconds: l.markSeconds, marginSeconds: l.marginSeconds,
        busyUntil: this.laserBusyUntil, onBusyUntil: until => this.noteBusyUntil(until),
      });
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
    if (action !== "release") {
      this.assertIdle();
      if (!this.config.safetyConfirmed) throw new LaserCellError("Confirm the UV guard first: a foot-switch press runs the whole job loaded in Studio");
    }
    if (this.config.laser.driver !== "studio-footswitch") throw new LaserCellError("The foot switch is only used on the ComMarker Studio route");
    const stops = this.stops;
    const laser = await this.laserDriver();
    if (!(laser instanceof StudioFootswitchLaser)) throw new LaserCellError("The foot-switch relay is not available");
    // Stop pressed while the relay was opening (an Arduino takes 2 s): press nothing.
    if (action !== "release" && stops !== this.stops) throw new LaserCellError("Stopped by operator");
    if (action !== "release") this.assertIdle();
    if (action === "press") await laser.press();
    else await laser.setHeld(action === "hold");
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
    return this.exclusive("loading the job into ComMarker Studio", async signal => {
      if (this.config.laser.driver !== "studio-window") throw new LaserCellError("Choose \"ComMarker Studio (fabPlane presses Start in Studio)\" as the laser route first");
      const laser = await this.laserDriver();
      if (!(laser instanceof StudioWindowLaser)) throw new LaserCellError("The Studio window driver is not available");
      if ((await launchStudio(laser.ui, this.config.laser.studioExe ?? DEFAULT_STUDIO_EXE, 45_000, signal)) === "started") this.log("info", "started ComMarker Studio");
      if (signal.aborted) throw new LaserCellError("Stopped by operator");
      const result = await laser.loadJob(spec, signal);
      for (const line of result.log) this.log(/check in Studio|no Power|not found|greyed/.test(line) ? "warn" : "info", `Studio: ${line}`);
      return result;
    });
  }

  // ------------------------------------------------------------ laser job (fabPlane USB / Wi-Fi driver)

  private jobViewOptions() {
    const m = this.config.laser.lmc;
    return { fieldMm: m.fieldMm, defaultCenterMm: m.centerMm, maxPowerPct: m.maxPowerPct };
  }

  /** The current job with its preview, and the material presets; `error` says why there is no job. */
  async jobView(): Promise<{ job: JobView | null; presets: typeof MATERIAL_PRESETS; error?: string }> {
    await this.load();
    const presets = MATERIAL_PRESETS;
    if (!this.config.laser.jobPath) return { job: null, presets, error: "No laser job yet: make one from a board, or open a drawing." };
    const path = this.lmcJobPath();
    try {
      return { job: jobView(await readJob(path), path, this.jobViewOptions()), presets };
    } catch (error) {
      return { job: null, presets, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Changes the current job's fill / outline settings or its place on the lens (null = the jig position). */
  async updateJob(patch: { settings?: JobSettings; edge?: EdgeSettings | null; positionMm?: { x: number; y: number } | null }): Promise<JobView> {
    await this.load();
    // Under the cell's lock: a run cannot start in the middle and mark a half-saved job.
    return this.exclusive("saving the laser job", () => this.saveJobPatch(patch));
  }

  private async saveJobPatch(patch: { settings?: JobSettings; edge?: EdgeSettings | null; positionMm?: { x: number; y: number } | null }): Promise<JobView> {
    const path = this.lmcJobPath();
    const next: LmcJob = { ...(await readJob(path).catch(error => { throw new LaserCellError(error instanceof Error ? error.message : String(error)); })) };
    if (patch.settings) next.settings = patch.settings;
    if (patch.edge !== undefined) { if (patch.edge && patch.edge.passes > 0) next.edge = patch.edge; else delete next.edge; }
    if (patch.positionMm !== undefined) { if (patch.positionMm) next.positionMm = patch.positionMm; else delete next.positionMm; }
    try {
      validateSettings({ ...DEFAULT_TIMING, ...next.settings });
      if (next.edge) validateSettings({ ...DEFAULT_TIMING, ...next.settings, ...next.edge, passes: Math.max(1, next.edge.passes) });
    } catch (error) {
      throw new LaserCellError(`Job not saved: ${error instanceof Error ? error.message.replace(/^laser setting out of range: /, "") : String(error)} is out of range`);
    }
    await writeJob(path, next);
    this.log("info", `laser job saved: ${next.settings.powerPct} %, ${next.settings.speedMmPerS} mm/s, ${next.settings.passes} pass(es)${next.positionMm ? `, at X ${next.positionMm.x} Y ${next.positionMm.y}` : ""}`);
    return jobView(next, path, this.jobViewOptions());
  }

  /**
   * Opens a drawing (SVG / DXF text) as the current laser job, in `<home>/laser-jobs/<name>.lmc.json`. Opening
   * the same file again keeps its settings and position; a new drawing starts gentle (FR4 marking preset).
   */
  async importArt(input: { fileName: string; format: ArtFormat; text: string; widthMm?: number; heightMm?: number; rotateDeg?: number; mirror?: boolean }): Promise<{ job: JobView; warnings: string[] }> {
    await this.load();
    return this.exclusive("opening a drawing", () => this.importArtLocked(input));
  }

  private async importArtLocked(input: { fileName: string; format: ArtFormat; text: string; widthMm?: number; heightMm?: number; rotateDeg?: number; mirror?: boolean }): Promise<{ job: JobView; warnings: string[] }> {
    let art;
    try {
      art = await importArt(input.text, input.format);
    } catch (error) {
      throw new LaserCellError(`Could not open ${input.fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sourceName = input.fileName.replace(/^.*[\\/]/, "");
    const stem = jobStem(sourceName);
    const dir = join(this.deps.home, "laser-jobs");
    await mkdir(dir, { recursive: true });
    // The job file of this very drawing (same file name), or a free name: two drawings whose names look alike
    // ("a b.svg" / "a-b.svg", "logo.svg" / "logo.dxf") never share settings, power or position.
    let name = stem, path = join(dir, `${stem}.lmc.json`), previous: LmcJob | null = null;
    for (let n = 1; ; n++) {
      name = n === 1 ? stem : `${stem}-${n}`;
      path = join(dir, `${name}.lmc.json`);
      const existing = await readJob(path).catch(() => null);
      if (!existing && !(await Bun.file(path).exists())) break;
      if (existing?.sourceName === sourceName) { previous = existing; break; }
      if (n > 999) throw new LaserCellError("Too many drawings with this name; rename the file");
    }
    const gentle = MATERIAL_PRESETS.find(p => p.id === "fr4-mark")!;
    let job: LmcJob;
    const warnings = [...art.warnings];
    const base = {
      name,
      sourceName,
      settings: previous?.settings ?? gentle.settings,
      ...(previous?.edge ? { edge: previous.edge } : {}),
      ...(previous?.positionMm ? { positionMm: previous.positionMm } : {}),
    };
    const turn = { rotateDeg: input.rotateDeg ?? 0, mirror: input.mirror ?? false };
    try {
      job = artToJob(art, { ...(input.widthMm !== undefined ? { widthMm: input.widthMm } : input.heightMm !== undefined ? { heightMm: input.heightMm } : {}), ...turn }, base);
      // No size asked and bigger than the lens (often a drawing in metres or inches): fit it, and say so.
      const field = this.config.laser.lmc.fieldMm;
      if (input.widthMm === undefined && input.heightMm === undefined && Math.max(job.boardMm.width, job.boardMm.height) > field) {
        const was = `${job.boardMm.width.toFixed(1)} × ${job.boardMm.height.toFixed(1)} mm`;
        const fit = Math.round(field * 0.9);
        job = artToJob(art, { ...(job.boardMm.width >= job.boardMm.height ? { widthMm: fit } : { heightMm: fit }), ...turn }, base);
        warnings.unshift(`The drawing is ${was}, bigger than the ${field} mm lens field; scaled down to ${job.boardMm.width.toFixed(1)} × ${job.boardMm.height.toFixed(1)} mm. Check its units and set the width you want.`);
      }
      LmcJobFileSchema.parse(job);
    } catch (error) {
      const why = error instanceof z.ZodError ? "it is far bigger than any lens field; set a width" : error instanceof Error ? error.message : String(error);
      throw new LaserCellError(`Could not open ${input.fileName}: ${why}`);
    }
    await writeJob(path, job);
    this.config = { ...this.config, laser: { ...this.config.laser, jobPath: path } };
    await this.save();
    this.log("info", `opened ${input.fileName}: ${job.boardMm.width.toFixed(1)} × ${job.boardMm.height.toFixed(1)} mm`);
    return { job: jobView(job, path, this.jobViewOptions()), warnings };
  }

  private runningLmc(): LmcLaser {
    if (!this.runState.active || this.abort?.signal.aborted) throw new LaserCellError("Nothing is running");
    if (!(this.laser instanceof LmcLaser)) throw new LaserCellError("Pause works with fabPlane's own laser driver; on the Studio route use Studio's own Pause");
    return this.laser;
  }

  /** Holds the running job after the line it is on (fabPlane USB / Wi-Fi driver). Stop still works. */
  async pause(): Promise<void> {
    await this.runningLmc().pause();
    this.log("warn", "laser job paused");
  }

  /** Continues a paused job. */
  async resume(): Promise<void> {
    await this.runningLmc().resume();
    this.log("info", "laser job resumed");
  }

  /** Runs one non-run operation; refuses while anything else runs; Stop aborts it. */
  private async exclusive<T>(kind: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertIdle();
    const op: { kind: string; abort: AbortController; done: Promise<unknown> } = { kind, abort: new AbortController(), done: Promise.resolve() };
    this.operation = op;
    const work = (async () => {
      try {
        return await fn(op.abort.signal);
      } finally {
        if (this.operation === op) this.operation = null;
      }
    })();
    op.done = work.catch(() => undefined);
    return work;
  }

  /**
   * Arm moves stay out of the laser area while the laser is marking (a job started by hand in Studio, a
   * foot-switch press, a USB job). An unreachable laser does not block them: it is not marking from here.
   */
  private async assertLaserNotMarking(): Promise<void> {
    const laser = await this.laserDriver().catch(() => null);
    const status = laser ? await laser.status().catch(() => null) : null;
    if (status?.state === "busy") throw new LaserCellError(`The laser is busy (${status.detail}); the arm stays where it is until the laser has finished`);
  }

  // ------------------------------------------------------------ fabPlane USB driver (usb-lmc)

  private lmcJobPath(): string {
    const job = this.config.laser.jobPath;
    if (!job) throw new LaserCellError("No laser job chosen: Make laser job, then Use this job");
    return job.replace(/\.(lbrn2|svg|json)$/i, "").replace(/\.lmc$/i, "") + ".lmc.json";
  }

  private async lmcLaser(): Promise<LmcLaser> {
    await this.load();
    if (this.config.laser.driver !== "usb-lmc") throw new LaserCellError('Choose "fabPlane USB driver" as the laser route first');
    const laser = await this.laserDriver();
    if (!(laser instanceof LmcLaser)) throw new LaserCellError("The USB laser driver is not available");
    return laser;
  }

  /**
   * Every laser this computer can see, read-only: a laser board on USB (and whether its Windows driver lets
   * fabPlane open it), the Omni X's own Wi-Fi hotspot, and fabPlane laser bridges on this computer's networks.
   */
  async findLasers(): Promise<{ findings: LaserFinding[]; notes: string[] }> {
    await this.load();
    const result = await findLasers({ port: this.config.laser.lmc.port });
    const summary = result.findings.map(f => (f.kind === "usb" ? `USB board ${f.vid}:${f.pid} (driver ${f.driver ?? "none"})` : f.kind === "bridge" ? `bridge ${f.host}:${f.port}` : `hotspot ${f.ssid}`));
    this.log("info", summary.length ? `found: ${summary.join(", ")}` : "no laser found on USB, Wi-Fi or the network");
    return result;
  }

  /** USB devices on this computer, the BJJCZ board (9588:9899) marked. */
  async usbDevices(): Promise<Array<{ vid: string; pid: string; laser: boolean }>> {
    const hex = (n: number) => n.toString(16).padStart(4, "0");
    return (await listUsbDevices()).map(d => ({ vid: hex(d.vid), pid: hex(d.pid), laser: d.vid === LMC_VID && d.pid === LMC_PID }));
  }

  /** Read-only connection check: serial number, version and status words. */
  async usbProbe(): Promise<{ serial: number[]; version: number[]; status: number }> {
    this.assertIdle();
    const laser = await this.lmcLaser();
    const p = await laser.probe();
    this.log("info", `USB laser board found: version ${p.version.map(w => w.toString(16)).join(".")}, status 0x${p.status.toString(16)}`);
    return p;
  }

  /**
   * Red-light frame around the loaded job. Needs the UV-guard confirmation: until the light pin is
   * confirmed on the machine, a wrong pin could fire the UV source.
   */
  async preview(seconds: number): Promise<void> {
    await this.load();
    if (!this.config.safetyConfirmed) throw new LaserCellError("Confirm the UV guard first: the red-light pin is not yet verified on this laser");
    await this.exclusive("red-light preview", async signal => {
      const laser = await this.lmcLaser();
      await laser.load(this.lmcJobPath());
      if (signal.aborted) throw new LaserCellError("Stopped by operator");
      this.log("info", `red-light preview for ${seconds} s`);
      await laser.frame(seconds, signal);
    });
  }

  async moveTo(name: PoseName): Promise<void> {
    await this.load();
    const pose = (this.config.poses as CellPoses)[name];
    if (!pose) throw new LaserCellError(`${POSE_LABELS[name]} has not been taught yet`);
    const arm = this.requireArm();
    this.assertIdle();
    await this.assertLaserNotMarking();
    await this.exclusive(`moving the arm to ${POSE_LABELS[name]}`, async signal => {
      await arm.prepare();
      await arm.moveTo(pose, { speed: this.config.arm.approachSpeed, signal });
    });
  }

  // ------------------------------------------------------------ running

  private assertIdle(): void {
    if (this.runState.active) throw new LaserCellError("The cell is running; stop it first");
    if (this.operation) throw new LaserCellError(`The cell is busy (${this.operation.kind}); wait or press Stop`);
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
    // Take the run lock before the first await: a second Start (another window, the agent) is refused, and
    // a Stop during the job load below is not lost.
    const controller = new AbortController();
    this.abort = controller;
    this.runState = { active: true, mode: request.mode, step: "preflight", visited: [], note: "Preparing", progress: 0, board: 0, boards, done: 0, startedAt: new Date().toISOString(), error: null };
    let laser: LaserDriver;
    try {
      laser = request.mode === "dry-run" ? new SimulatedLaser(0) : await this.laserDriver();
      if (this.config.laser.driver === "lightburn" && request.mode !== "dry-run") {
        if (!this.config.laser.jobPath) throw new LaserCellError("Choose the LightBurn job file first");
        await laser.load?.(this.config.laser.jobPath);
      }
      if (this.config.laser.driver === "usb-lmc" && request.mode !== "dry-run") await laser.load?.(this.lmcJobPath());
      if (controller.signal.aborted) throw new LaserCellError("Stopped by operator");
    } catch (error) {
      this.runState = { ...this.runState, active: false, error: error instanceof Error ? error.message : String(error) };
      this.abort = null;
      throw error;
    }
    this.log("info", `${request.mode} started for ${boards} board(s) with ${laser.name}`);
    this.running = (async () => {
      try {
        for (let board = 1; board <= boards; board++) {
          this.runState.board = board;
          this.runState.visited = [];
          try {
            await runCycle(this.arm, laser, this.config.poses as CellPoses, {
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
  async stop(options: { quiet?: boolean } = {}): Promise<void> {
    const active = !!this.abort || !!this.operation;
    if (!active && options.quiet) return;
    this.log("warn", active ? "stop requested" : "stop requested (nothing was running; laser and arm stopped anyway)");
    this.stops++;
    this.abort?.abort();
    const op = this.operation;
    op?.abort.abort();
    // Always (a preview, a Go move or a held foot switch is not a run), and laser and arm at the same time:
    // an unreachable laser must not delay freezing the arm.
    await Promise.all([this.laser?.stop().catch(() => undefined), this.arm?.stop().catch(() => undefined)]);
    // Give the stopped operation a moment to let go of the cell, so the next action is not refused as busy.
    if (op) await Promise.race([op.done, new Promise(r => setTimeout(r, 3000))]);
    await this.running?.catch(() => undefined);
  }

  /** Wait for the current run (tests). */
  async settled(): Promise<void> {
    await this.running?.catch(() => undefined);
  }

  /**
   * Laser status, cached for STATUS_CACHE_MS and shared between callers: the Laser Controller and the
   * workspace both poll, and on the Studio route every check starts a PowerShell process.
   */
  private laserStatus: { at: number; key: string; value: LaserStatus } | null = null;
  private laserProbing: Promise<LaserStatus> | null = null;

  private probeLaser(): Promise<LaserStatus> {
    const key = JSON.stringify(this.config.laser);
    if (this.laserStatus && this.laserStatus.key === key && Date.now() - this.laserStatus.at < STATUS_CACHE_MS) return Promise.resolve(this.laserStatus.value);
    if (this.laserProbing) return this.laserProbing;
    this.laserProbing = (async () => {
      let value: LaserStatus;
      try {
        value = await (await this.laserDriver()).status();
      } catch (error) {
        value = { state: "offline", detail: error instanceof Error ? error.message : String(error), driver: this.config.laser.driver };
      }
      this.laserStatus = { at: Date.now(), key, value };
      return value;
    })().finally(() => { this.laserProbing = null; });
    return this.laserProbing;
  }

  /** The run state, with the USB / Wi-Fi driver's job progress while it marks. */
  private runWithProgress(): CellSnapshot["run"] {
    const run = { ...this.runState, visited: [...this.runState.visited] };
    const p = run.active && run.step === "mark" && this.laser instanceof LmcLaser ? this.laser.progress() : null;
    const lmc = this.laser instanceof LmcLaser ? this.laser : null;
    return p ? { ...run, progress: p.fraction, remainingSeconds: p.remainingSeconds, paused: p.paused, pausable: !!lmc?.canPause && !this.abort?.signal.aborted } : { ...run, pausable: false };
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
    let laser: LaserStatus | null = this.laserStatus?.value ?? null;
    if (this.runState.active) {
      laser = { state: "busy", detail: `running: board ${this.runState.board} of ${this.runState.boards}`, driver: this.config.laser.driver };
    } else if (this.operation) {
      laser = { state: "busy", detail: this.operation.kind, driver: this.config.laser.driver };
    } else if (options.probe !== false) {
      laser = await this.probeLaser();
    }
    const poses = this.config.poses as CellPoses;
    return {
      // The bridge access key never leaves the core (snapshots end up in agent transcripts).
      config: this.publicConfig(),
      configPath: this.configPath,
      arm: { connected: !!this.arm, port: this.config.arm.port, joints, error: this.armError },
      laser,
      poses: POSE_NAMES.map(name => ({ name, label: POSE_LABELS[name], taught: !!poses[name] && Object.keys(poses[name]!).length > 0 })),
      missing: missingPoses(poses),
      run: this.runWithProgress(),
      log: this.logEntries.slice(-60),
      operation: this.operation?.kind ?? null,
    };
  }

  async dispose(): Promise<void> {
    await this.stop({ quiet: true });
    await this.arm?.bus.close().catch(() => undefined);
    await this.laser?.close?.().catch(() => undefined); // a held foot switch counts as released: busy time saved
    this.arm = null;
    this.laser = null;
    await this.busyWrites;
  }
}
