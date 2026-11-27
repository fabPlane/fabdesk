/**
 * `usb-lmc` laser route: fabPlane drives a BJJCZ LMC board directly over USB (no ComMarker Studio).
 * Protocol: ./protocol.ts (from galvoplotter, MIT). Job: ./job.ts. Transport: ./usb.ts, ./bridge.ts.
 *
 * NOT VERIFIED ON AN OMNI X. LightBurn drives the Omni X as a BJJCZ board, so the protocol should match,
 * but these are guesses until tested on the machine, and are therefore settings:
 * - USB id 9588:9899, the laser and red-light output pins (defaults from galvoplotter: 0 and 8),
 * - how the UV source takes power/frequency (`source`: co2-style PWM ratio or fiber-style current),
 * - the board initialisation values (galvoplotter's defaults), the galvo axis directions,
 * - the lens correction: a flat (identity) table is sent, so the field may be slightly distorted.
 * First test on the machine: probe (read-only), then a red-light frame, then a small low-power mark.
 *
 * Safety rules this class keeps:
 * - one operation (mark or preview) at a time;
 * - stop() bumps a generation number; every packet write and every ExecuteList checks it first, so nothing
 *   is sent or started after a stop, and stop's own commands wait behind at most one in-flight command;
 * - any transport error or timeout drops the connection, so a late reply can never be read as the answer
 *   to a later command (the next command reconnects);
 * - every mark is capped at `maxPowerPct`; job settings are range-checked, never wrapped.
 */
import { readFile } from "node:fs/promises";
import type { LaserDriver, LaserStatus } from "../cell";
import { LaserDriverError } from "../lasers";
import { assertInField, buildLightFrame, markPackets, validateSettings, type FieldMap, type MarkSettings, type Pins, type Shape, type SourceMode } from "./job";
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
  /** How long the board may stay busy before it takes the next list packet (a packet can hold long lines). */
  readyTimeoutMs?: number;
  /** How the board is reached, for messages: "USB" or "the Wi-Fi bridge". */
  link?: string;
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

type Operation = "marking" | "preview";

export class LmcLaser implements LaserDriver {
  readonly name = "fabPlane USB driver (BJJCZ, experimental)";
  private transport: LmcTransport | null = null;
  private connecting: Promise<LmcTransport> | null = null;
  private job: LmcJobFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  /** Bumped by stop(); an operation that sees a different value has been stopped. */
  private generation = 0;
  private operation: Operation | null = null;
  /** Serial number and version words read on connect. */
  info: { serial: Reply["words"]; version: Reply["words"] } | null = null;

  constructor(private readonly open: () => Promise<LmcTransport>, readonly options: LmcOptions) {}

  // ------------------------------------------------------------ connection

  /** One shared connection: concurrent callers wait for the same open + init. */
  connect(): Promise<LmcTransport> {
    if (this.transport) return Promise.resolve(this.transport);
    this.connecting ??= (async () => {
      const t = await this.open();
      try {
        const raw = async (op: number, ...p: number[]) => parseReply(await exchange(t, command(op, ...p)));
        this.info = { serial: (await raw(Cmd.GetSerialNo)).words, version: (await raw(Cmd.GetVersion)).words };
        if (this.options.initBoard) await this.initBoard(raw);
      } catch (error) {
        await t.close().catch(() => undefined);
        throw error;
      }
      this.transport = t;
      return t;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
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

  /** Drops a transport after an error: the next command reconnects instead of reading a stale reply. */
  private async drop(t: LmcTransport) {
    if (this.transport === t) this.transport = null;
    await t.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    const t = this.transport;
    this.transport = null;
    await t?.close().catch(() => undefined);
  }

  /** Runs `fn` on the connection, one at a time; drops the connection if it fails. */
  private serial<T>(fn: (t: LmcTransport) => Promise<T>): Promise<T> {
    const go = async () => {
      const t = await this.connect();
      try {
        return await fn(t);
      } catch (error) {
        await this.drop(t);
        throw error;
      }
    };
    const next = this.queue.then(go, go);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** One realtime command and its reply. */
  private single(op: number, ...params: number[]): Promise<Reply> {
    return this.serial(async t => parseReply(await exchange(t, command(op, ...params))));
  }

  // ------------------------------------------------------------ status and job

  /** Read-only check: serial and version words, status. */
  async probe(): Promise<{ serial: Reply["words"]; version: Reply["words"]; status: number }> {
    const v = await this.single(Cmd.GetVersion);
    return { serial: this.info!.serial, version: v.words, status: v.status };
  }

  async status(): Promise<LaserStatus> {
    // During an operation the operation itself polls the board; do not interleave or reconnect.
    if (this.operation) return { state: "busy", detail: this.operation === "preview" ? "showing the red-light preview" : "marking", driver: this.name };
    try {
      const r = await this.single(Cmd.GetVersion);
      if (isBusy(r.status)) return { state: "busy", detail: "the laser board is running a list", driver: this.name };
      return { state: "idle", detail: `connected over ${this.options.link ?? "USB"}${this.job ? "; job loaded" : "; no job loaded (Make laser job, then Use this job)"}`, driver: this.name };
    } catch (error) {
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

  // ------------------------------------------------------------ operations

  private begin(operation: Operation): number {
    if (this.operation) throw new LaserDriverError(`the laser is busy (${this.operation}); stop it first`);
    this.operation = operation;
    return this.generation;
  }

  private checkNotStopped(generation: number) {
    if (generation !== this.generation) throw new LaserDriverError("stopped");
  }

  /**
   * Sends list packets and runs them (galvoplotter's sequence: wait ready, packet, end-of-list mark, execute
   * after the third). Checks for a stop before every write and every execute.
   */
  private async runList(packets: Iterable<Uint8Array>, generation: number, signal?: AbortSignal) {
    await this.single(Cmd.ResetList);
    let executing = false;
    let i = 0;
    for (const packet of packets) {
      const deadline = Date.now() + (this.options.readyTimeoutMs ?? 10 * 60_000);
      for (;;) {
        this.checkNotStopped(generation);
        if (isReady((await this.single(Cmd.GetVersion)).status)) break;
        if (Date.now() > deadline) throw new LaserDriverError("the laser board did not take the next part of the job in time");
        await sleep(this.options.pollMs ?? 10, signal);
      }
      this.checkNotStopped(generation);
      await this.serial(t => t.write(packet));
      await this.single(Cmd.SetEndOfList, 0);
      if (i >= 2 && !executing) {
        this.checkNotStopped(generation);
        await this.single(Cmd.ExecuteList);
        executing = true;
      }
      i++;
    }
    this.checkNotStopped(generation);
    if (!executing) await this.single(Cmd.ExecuteList);
  }

  private async waitIdle(generation: number, timeoutMs: number, signal?: AbortSignal) {
    const started = Date.now();
    for (;;) {
      this.checkNotStopped(generation);
      if (!isBusy((await this.single(Cmd.GetVersion)).status)) return;
      if (Date.now() - started > timeoutMs) throw new LaserDriverError(`the laser is still marking after ${Math.round(timeoutMs / 1000)} s`);
      await sleep(this.options.pollMs ?? 200, signal);
    }
  }

  /** Outputs off (and the fiber source's MO closed) after a job, a preview or a stop. */
  private async outputsOff() {
    await this.single(Cmd.WritePort, 0).catch(() => undefined);
    if (this.options.source === "fiber") await this.single(Cmd.FiberSetMo, 0).catch(() => undefined);
  }

  /** Red-light frame around the job (laser pin off). Stoppable with stop(). */
  async frame(seconds: number, signal?: AbortSignal): Promise<void> {
    const job = this.requireJob();
    const field = this.field(job);
    assertInField(job.ablate as Shape, field);
    const once = buildLightFrame(job.ablate, field, { pins: this.options.pins, travelMmPerS: 1000, loops: 1 });
    const loops = Math.max(1, Math.min(500, Math.round((seconds || this.options.frameSeconds) / Math.max(0.05, once.estimatedSeconds))));
    const generation = this.begin("preview");
    try {
      await this.runList(buildLightFrame(job.ablate, field, { pins: this.options.pins, travelMmPerS: 1000, loops }).packets, generation, signal);
      await this.waitIdle(generation, 60_000, signal);
    } catch (error) {
      if (generation === this.generation) await this.haltBoard();
      throw error;
    } finally {
      await this.outputsOff();
      this.operation = null;
    }
  }

  async start(): Promise<void> {
    const job = this.requireJob();
    const s = job.settings;
    const settings: MarkSettings = { ...DEFAULT_TIMING, ...s, powerPct: Math.min(s.powerPct, this.options.maxPowerPct) };
    validateSettings(settings);
    const field = this.field(job);
    assertInField(job.ablate as Shape, field); // before anything reaches the board
    const packets = markPackets(job.ablate as Shape, field, settings, { source: this.options.source, pins: this.options.pins });
    const generation = this.begin("marking");
    try {
      if (this.options.source === "fiber") await this.single(Cmd.FiberSetMo, 1);
      await this.runList(packets, generation);
    } catch (error) {
      if (generation === this.generation) await this.haltBoard();
      await this.outputsOff();
      this.operation = null;
      throw error;
    }
  }

  async waitDone({ timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
    const generation = this.generation;
    try {
      await this.waitIdle(generation, timeoutMs, signal);
    } catch (error) {
      if (generation === this.generation) await this.haltBoard();
      throw error;
    } finally {
      await this.outputsOff();
      this.operation = null;
    }
  }

  private async haltBoard() {
    await this.single(Cmd.StopExecute).catch(() => undefined);
    await this.single(Cmd.ResetList).catch(() => undefined);
    await this.outputsOff();
  }

  /**
   * Stops the list on the board and switches the outputs off; any operation in progress gives up before its
   * next write. Keep the machine's E-stop within reach.
   */
  async stop(): Promise<void> {
    this.generation++;
    await this.haltBoard();
    this.operation = null;
  }

  get isRunning(): boolean {
    return this.operation !== null;
  }
}

/** Write + reply as one exchange (one network round trip over the bridge). */
async function exchange(t: LmcTransport, packet: Uint8Array): Promise<Uint8Array> {
  if (t.transact) return t.transact(packet);
  await t.write(packet);
  return t.read();
}
