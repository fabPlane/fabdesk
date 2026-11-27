/**
 * `usb-lmc` laser route: fabPlane drives a BJJCZ LMC board directly over USB (no ComMarker Studio).
 * Protocol: ./protocol.ts (from galvoplotter, MIT). Job: ./job.ts. Transport: ./usb.ts.
 *
 * NOT VERIFIED ON AN OMNI X. LightBurn drives the Omni X as a BJJCZ board, so the protocol should match,
 * but these are guesses until tested on the machine, and are therefore settings:
 * - USB id 9588:9899, the laser and red-light output pins (defaults from galvoplotter: 0 and 8),
 * - how the UV source takes power/frequency (`source`: co2-style PWM ratio or fiber-style current),
 * - the board initialisation values (galvoplotter's defaults), the galvo axis directions,
 * - the lens correction: a flat (identity) table is sent, so the field may be slightly distorted.
 * First test on the machine: probe (read-only), then a red-light frame, then a small low-power mark.
 */
import { readFile } from "node:fs/promises";
import type { LaserDriver, LaserStatus } from "../cell";
import { LaserDriverError } from "../lasers";
import { buildLightFrame, buildMarkJob, type FieldMap, type MarkSettings, type Pins, type Shape, type SourceMode } from "./job";
import { Cmd, command, isBusy, isReady, parseReply, type Reply } from "./protocol";
import type { LmcTransport } from "./usb";

export type LmcOptions = {
  field: Omit<FieldMap, "boardMm">;
  source: SourceMode;
  pins: Pins;
  /** Hard cap on power, whatever the job asks for (first tests: 10–20 %). */
  maxPowerPct: number;
  /** Send galvoplotter's board initialisation on connect. */
  initBoard: boolean;
  /** Seconds the red-light frame is shown. */
  frameSeconds: number;
  pollMs?: number;
};

/** Job file written by export_laser_copper: `<stem>.lmc.json`. */
export type LmcJobFile = {
  boardMm: { width: number; height: number };
  /** Rings in mm, job coordinates (origin bottom-left, Y up), even-odd. */
  ablate: Array<Array<[number, number]>>;
  settings: { powerPct: number; speedMmPerS: number; frequencyKhz: number; passes: number; intervalMm: number; angleDeg: number; angleStepDeg: number };
};

const DEFAULT_TIMING = { travelMmPerS: 2000, laserOnDelayUs: 100, laserOffDelayUs: 100, polygonDelayUs: 100, jumpDelayUs: 200 };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new LaserDriverError("stopped"));
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new LaserDriverError("stopped")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class LmcLaser implements LaserDriver {
  readonly name = "fabPlane USB driver (BJJCZ, experimental)";
  private transport: LmcTransport | null = null;
  private job: LmcJobFile | null = null;
  private running = false;
  /** Set by stop(): the packet loop gives up instead of feeding the board more of the job. */
  private stopRequested = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Serial number and version words read on connect. */
  info: { serial: Reply["words"]; version: Reply["words"] } | null = null;

  constructor(private readonly open: () => Promise<LmcTransport>, readonly options: LmcOptions) {}

  /** One single command and its reply, serialised. */
  private single(op: number, ...params: number[]): Promise<Reply> {
    const go = async () => {
      const t = await this.connect();
      await t.write(command(op, ...params));
      return parseReply(await t.read());
    };
    const next = this.queue.then(go, go);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async connect(): Promise<LmcTransport> {
    if (this.transport) return this.transport;
    const t = await this.open();
    this.transport = t;
    try {
      const raw = async (op: number, ...p: number[]) => { await t.write(command(op, ...p)); return parseReply(await t.read()); };
      this.info = { serial: (await raw(Cmd.GetSerialNo)).words, version: (await raw(Cmd.GetVersion)).words };
      if (this.options.initBoard) await this.initBoard(raw);
    } catch (error) {
      this.transport = null;
      await t.close().catch(() => undefined);
      throw error;
    }
    return t;
  }

  /** galvoplotter's initialisation sequence with its default values; flat lens correction. */
  private async initBoard(raw: (op: number, ...p: number[]) => Promise<Reply>) {
    await raw(Cmd.Reset);
    await raw(Cmd.WriteCorTable, 0);
    await raw(Cmd.EnableLaser);
    await raw(Cmd.SetControlMode, 0);
    await raw(Cmd.SetLaserMode, 1);
    await raw(Cmd.SetDelayMode, 1);
    await raw(Cmd.SetTiming, 1);
    await raw(Cmd.SetStandby, 2000, 20);
    await raw(Cmd.SetFirstPulseKiller, 200);
    await raw(Cmd.SetPwmHalfPeriod, 125);
    await raw(Cmd.SetPwmPulseWidth, 125);
    if (this.options.source === "fiber") await raw(Cmd.FiberSetMo, 0);
    await raw(Cmd.SetFpkParam2, 0xffb, 1, 409, 100);
    await raw(Cmd.EnableZ);
    await raw(Cmd.WriteAnalogPort1, 0x7ff);
  }

  async close(): Promise<void> {
    const t = this.transport;
    this.transport = null;
    await t?.close();
  }

  /** Read-only check: serial and version words, status. */
  async probe(): Promise<{ serial: Reply["words"]; version: Reply["words"]; status: number }> {
    await this.connect();
    const v = await this.single(Cmd.GetVersion);
    return { serial: this.info!.serial, version: v.words, status: v.status };
  }

  async status(): Promise<LaserStatus> {
    try {
      const r = await this.single(Cmd.GetVersion);
      if (isBusy(r.status)) return { state: "busy", detail: "the laser board is running a list", driver: this.name };
      return { state: "idle", detail: `connected over USB${this.job ? "; job loaded" : "; no job loaded (Make laser job, then Use this job)"}`, driver: this.name };
    } catch (error) {
      await this.close().catch(() => undefined);
      return { state: "offline", detail: error instanceof Error ? error.message : String(error), driver: this.name };
    }
  }

  /** Loads `<stem>.lmc.json` from export_laser_copper. */
  async load(path: string): Promise<void> {
    const job = JSON.parse(await readFile(path, "utf8")) as LmcJobFile;
    if (!job.ablate?.length || !job.boardMm || !job.settings) throw new LaserDriverError(`${path} is not a fabPlane USB laser job; export the laser job again`);
    this.job = job;
  }

  private requireJob(): LmcJobFile {
    if (!this.job) throw new LaserDriverError("no laser job loaded: Make laser job, then Use this job in the cell");
    return this.job;
  }

  private field(job: LmcJobFile): FieldMap {
    return { ...this.options.field, boardMm: job.boardMm };
  }

  /** Sends list packets and runs them (galvoplotter's sequence: wait ready, packet, end-of-list mark, execute after the third). */
  private async runList(packets: Uint8Array[], signal?: AbortSignal) {
    const t = await this.connect();
    await this.single(Cmd.ResetList);
    let executing = false;
    for (let i = 0; i < packets.length; i++) {
      if (this.stopRequested) throw new LaserDriverError("stopped");
      for (let tries = 0; !isReady((await this.single(Cmd.GetVersion)).status); tries++) {
        if (tries > 2000) throw new LaserDriverError("the laser board never became ready for the next list packet");
        await sleep(this.options.pollMs ?? 10, signal);
      }
      await t.write(packets[i]!);
      await this.single(Cmd.SetEndOfList, 0);
      if (i >= 2 && !executing) { await this.single(Cmd.ExecuteList); executing = true; }
    }
    if (!executing) await this.single(Cmd.ExecuteList);
  }

  /** Red-light frame around the job (laser pin off). */
  async frame(seconds: number, signal?: AbortSignal): Promise<void> {
    const job = this.requireJob();
    const field = this.field(job);
    const once = buildLightFrame(job.ablate, field, { pins: this.options.pins, travelMmPerS: 1000, loops: 1 });
    this.stopRequested = false;
    const loops = Math.max(1, Math.min(500, Math.round((seconds || this.options.frameSeconds) / Math.max(0.05, once.estimatedSeconds))));
    await this.runList(buildLightFrame(job.ablate, field, { pins: this.options.pins, travelMmPerS: 1000, loops }).packets, signal);
    await this.waitIdle(60_000, signal);
    await this.single(Cmd.WritePort, 0);
  }

  async start(): Promise<void> {
    const job = this.requireJob();
    const s = job.settings;
    const settings: MarkSettings = { ...DEFAULT_TIMING, ...s, powerPct: Math.min(s.powerPct, this.options.maxPowerPct) };
    const built = buildMarkJob(job.ablate as Shape, this.field(job), settings, { source: this.options.source, pins: this.options.pins });
    this.stopRequested = false;
    this.running = true;
    try {
      await this.runList(built.packets);
    } catch (error) {
      this.running = false;
      await this.stop().catch(() => undefined);
      throw error;
    }
  }

  private async waitIdle(timeoutMs: number, signal?: AbortSignal) {
    const started = Date.now();
    for (;;) {
      if (!isBusy((await this.single(Cmd.GetVersion)).status)) return;
      if (Date.now() - started > timeoutMs) throw new LaserDriverError(`the laser is still marking after ${Math.round(timeoutMs / 1000)} s`);
      await sleep(this.options.pollMs ?? 200, signal);
    }
  }

  async waitDone({ timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
    try {
      await this.waitIdle(timeoutMs, signal);
      await this.single(Cmd.WritePort, 0);
    } finally {
      this.running = false;
    }
  }

  /** Stops the list on the board and switches the outputs off. Keep the machine's E-stop within reach. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    this.running = false;
    await this.single(Cmd.StopExecute).catch(() => undefined);
    await this.single(Cmd.ResetList).catch(() => undefined);
    await this.single(Cmd.WritePort, 0).catch(() => undefined);
  }

  get isRunning(): boolean {
    return this.running;
  }
}
