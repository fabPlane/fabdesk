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
import type { LaserDriver, LaserStatus } from "../cell";
import { LaserDriverError } from "../lasers";
import { assertInField, buildLightFrame, markPackets, validateSettings, type FieldMap, type MarkSettings, type Pins, type Shape, type SourceMode } from "./job";
import { DEFAULT_TIMING, estimateJobSeconds, readJob, type LmcJob } from "./job-file";
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

/** Job file (`<stem>.lmc.json`): a board side from export_laser_copper or an imported drawing. See ./job-file.ts. */
export type LmcJobFile = LmcJob;

/** Progress of the job being marked, from the time estimate (the board does not report progress). */
export type LmcProgress = { fraction: number; remainingSeconds: number; paused: boolean };

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
  /** Pause state of the job being marked; paused time does not count against any time limit. */
  private paused = false;
  private pausedAt = 0;
  private pausedMs = 0;
  private markStartedAt = 0;
  private estimate = 0;
  /** ExecuteList has been sent (set just before it goes out, so a pause then sends StopList after it). */
  private executing = false;
  /** Every packet of the job has been sent to the board. */
  private fed = false;
  /** The generation the current operation began in; pause / resume are refused after a stop. */
  private opGeneration = -1;
  /** Job mode: the bridge has the job; before that a pause is only recorded and sent once it has. */
  private handedOver = false;
  /** The current operation runs on the Wi-Fi bridge (job mode); its last reported progress. */
  private remote = false;
  private remoteProgress: LmcProgress | null = null;
  /** The halt in progress, shared by overlapping stop() calls. */
  private halting: Promise<void> | null = null;
  /** No operation has begun since the last completed halt: another stop() has nothing to send. */
  private cleanSinceHalt = false;
  /** Serial number and version words read on connect. */
  info: { serial: Reply["words"]; version: Reply["words"] } | null = null;

  constructor(private readonly open: () => Promise<LmcTransport>, readonly options: LmcOptions) {}

  // ------------------------------------------------------------ connection

  /** One shared connection: concurrent callers wait for the same open + init. */
  connect(): Promise<LmcTransport> {
    if (this.transport?.closed) {
      // The link died on its own (heartbeat timeout): reconnect now rather than fail the next command once.
      const dead = this.transport;
      this.transport = null;
      void dead.close().catch(() => undefined);
    }
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

  /** A command that is dropped if a stop happened before its turn on the link came (pause / resume). */
  private guardedSingle(generation: number, op: number): Promise<Reply> {
    return this.serial(async t => {
      if (generation !== this.generation) throw new LaserDriverError("stopped");
      return parseReply(await exchange(t, command(op)));
    });
  }

  private guardedRpc(generation: number, type: "U" | "V"): Promise<unknown> {
    return this.serial(async t => {
      if (generation !== this.generation) throw new LaserDriverError("stopped");
      return t.rpc!(type);
    });
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
    let job: LmcJob;
    try {
      job = await readJob(path);
    } catch (error) {
      throw new LaserDriverError(error instanceof Error ? error.message : String(error));
    }
    this.useJob(job);
  }

  /** Uses a job already in memory (checked by the caller); the Wi-Fi bridge's own driver gets jobs this way. */
  useJob(job: LmcJob): void {
    this.job = job;
    this.estimate = estimateJobSeconds({ ...job, settings: { ...job.settings, powerPct: Math.min(job.settings.powerPct, this.options.maxPowerPct) } });
  }

  /** Estimated marking time of the loaded job (s). */
  get estimatedSeconds(): number {
    return this.estimate;
  }

  private requireJob(): LmcJobFile {
    if (!this.job) throw new LaserDriverError("no laser job loaded: Make laser job, then Use this job in the cell");
    return this.job;
  }

  /** The job's own position on the lens wins over the cell's board centre (a drawing placed by hand). */
  private field(job: LmcJobFile): FieldMap {
    return { ...this.options.field, ...(job.positionMm ? { centerMm: [job.positionMm.x, job.positionMm.y] as [number, number] } : {}), boardMm: job.boardMm };
  }

  private everything(job: LmcJobFile): Shape {
    return [...job.ablate, ...(job.lines ?? []).filter(l => l.length >= 2)] as Shape;
  }

  // ------------------------------------------------------------ operations

  private begin(operation: Operation): number {
    if (this.operation) throw new LaserDriverError(`the laser is busy (${this.operation}); stop it first`);
    this.operation = operation;
    this.cleanSinceHalt = false;
    this.remote = false;
    this.remoteProgress = null;
    this.handedOver = false;
    this.fed = false;
    this.executing = false;
    this.opGeneration = this.generation;
    return this.generation;
  }

  private checkNotStopped(generation: number, signal?: AbortSignal) {
    if (generation !== this.generation || signal?.aborted) throw new LaserDriverError("stopped");
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
      // The packet in hand is always sent (never skipped): it may hold the power, speed and laser-pin settings.
      await this.waitToSend(generation, signal);
      this.checkNotStopped(generation, signal);
      await this.serial(t => t.write(packet));
      await this.single(Cmd.SetEndOfList, 0);
      if (i >= 2 && !executing) {
        await this.executeList(generation, signal);
        executing = true;
      }
      i++;
    }
    if (!executing) await this.executeList(generation, signal);
    this.fed = true;
  }

  /** Waits until the board can take the next packet and the job is not paused. */
  private async waitToSend(generation: number, signal?: AbortSignal) {
    let deadline = Date.now() + (this.options.readyTimeoutMs ?? 10 * 60_000);
    for (;;) {
      this.checkNotStopped(generation, signal);
      if (this.paused) { // nothing more goes to the board until Resume; paused time does not count
        await sleep(this.options.pollMs ?? 50, signal);
        deadline = Date.now() + (this.options.readyTimeoutMs ?? 10 * 60_000);
        continue;
      }
      const ready = isReady((await this.single(Cmd.GetVersion)).status);
      if (this.paused) continue; // paused while asking: ask again after Resume
      if (ready) return;
      if (Date.now() > deadline) throw new LaserDriverError("the laser board did not take the next part of the job in time");
      await sleep(this.options.pollMs ?? 10, signal);
    }
  }

  /** Starts the list, never while paused; a pause arriving while ExecuteList is on its way sends StopList after it. */
  private async executeList(generation: number, signal?: AbortSignal) {
    while (this.paused) { this.checkNotStopped(generation, signal); await sleep(this.options.pollMs ?? 50, signal); }
    this.checkNotStopped(generation, signal);
    this.executing = true;
    await this.single(Cmd.ExecuteList);
  }

  private async waitIdle(generation: number, timeoutMs: number, signal?: AbortSignal) {
    let started = Date.now();
    let idleReads = 0;
    for (;;) {
      this.checkNotStopped(generation, signal);
      if (this.paused) { // a paused list is not a finished one, and paused time does not count
        idleReads = 0;
        const before = Date.now();
        await sleep(this.options.pollMs ?? 200, signal);
        started += Date.now() - before;
        continue;
      }
      // Two idle answers in a row: one stale reply can never end a job early.
      if (!isBusy((await this.single(Cmd.GetVersion)).status)) { if (++idleReads >= 2) return; continue; }
      idleReads = 0;
      if (Date.now() - started > timeoutMs) throw new LaserDriverError(`the laser is still marking after ${Math.round(timeoutMs / 1000)} s`);
      await sleep(this.options.pollMs ?? 200, signal);
    }
  }

  /** Outputs off (and the fiber source's MO closed) after a job, a preview or a stop. */
  private async outputsOff() {
    if (!this.transport) return; // not connected: nothing to switch off, and do not reconnect just for this
    await this.single(Cmd.WritePort, 0).catch(() => undefined);
    if (this.options.source === "fiber") await this.single(Cmd.FiberSetMo, 0).catch(() => undefined);
  }

  /** Red-light frame around the job (laser pin off). Stoppable with stop(). */
  async frame(seconds: number, signal?: AbortSignal): Promise<void> {
    const job = this.requireJob();
    const field = this.field(job);
    const all = this.everything(job);
    assertInField(all, field);
    const once = buildLightFrame(all, field, { pins: this.options.pins, travelMmPerS: 1000, loops: 1 });
    const loops = Math.max(1, Math.min(500, Math.round((seconds || this.options.frameSeconds) / Math.max(0.05, once.estimatedSeconds))));
    const generation = this.begin("preview");
    try {
      this.checkNotStopped(generation, signal);
      if (await this.bridgeRuns()) {
        await this.serial(t => t.rpc!("J", { op: "frame", job, options: this.bridgeOptions(), seconds: seconds || this.options.frameSeconds }));
        this.remote = true;
        await this.waitBridge(generation, (seconds || this.options.frameSeconds) * 1000 + 60_000, signal);
        return;
      }
      await this.runList(buildLightFrame(all, field, { pins: this.options.pins, travelMmPerS: 1000, loops }).packets, generation, signal);
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
    assertInField(this.everything(job), field); // before anything reaches the board
    const edge = job.edge && job.edge.passes > 0
      ? { passes: job.edge.passes, settings: { ...settings, powerPct: Math.min(job.edge.powerPct, this.options.maxPowerPct), speedMmPerS: job.edge.speedMmPerS, frequencyKhz: job.edge.frequencyKhz } }
      : undefined;
    const packets = markPackets(job.ablate as Shape, field, settings, { source: this.options.source, pins: this.options.pins, ...(job.lines?.length ? { lines: job.lines } : {}), ...(edge ? { edge } : {}) });
    const generation = this.begin("marking");
    this.paused = false;
    this.pausedMs = 0;
    this.markStartedAt = Date.now();
    try {
      if (await this.bridgeRuns()) {
        // Job mode: the bridge builds and feeds the job itself; nothing per packet crosses the Wi-Fi.
        this.checkNotStopped(generation);
        this.remote = true;
        await this.serial(t => t.rpc!("J", { op: "mark", job, options: this.bridgeOptions() }, 60_000));
        this.handedOver = true;
        this.checkNotStopped(generation);
        // Pause pressed while the job was on its way: hold it now.
        if (this.paused) await this.guardedRpc(generation, "U");
        return;
      }
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
      if (this.remote) await this.waitBridge(generation, timeoutMs, signal);
      else await this.waitIdle(generation, timeoutMs, signal);
    } catch (error) {
      if (generation === this.generation) await this.haltBoard();
      throw error;
    } finally {
      await this.outputsOff();
      this.operation = null;
    }
  }

  /**
   * Holds the job: the board stops after the command it is on (StopList) and nothing more is sent until
   * resume(). Galvoplotter's pause. Stop still works while paused.
   */
  /** A job is being marked and no stop is under way: Pause can work. */
  get canPause(): boolean {
    return this.operation === "marking" && !this.halting && this.generation === this.opGeneration;
  }

  async pause(): Promise<void> {
    if (!this.canPause) throw new LaserDriverError("nothing is being marked");
    if (this.paused) return;
    const generation = this.generation;
    if (!this.remote && this.fed) {
      // The whole job is on the board. If it has already finished there is nothing to hold, and a later
      // RestartList must never run a finished list again.
      if (!isBusy((await this.single(Cmd.GetVersion)).status)) throw new LaserDriverError("the job is finishing; nothing to pause");
      if (generation !== this.generation) throw new LaserDriverError("stopped");
    }
    this.paused = true;
    this.pausedAt = Date.now();
    try {
      if (this.remote) { if (this.handedOver) await this.guardedRpc(generation, "U"); } // else sent once the bridge has the job
      else if (this.executing) await this.guardedSingle(generation, Cmd.StopList);
    } catch (error) {
      // The board was not held: the job runs on, and its time counts again.
      if (generation === this.generation) this.paused = false;
      throw error;
    }
  }

  /** Continues a paused job where it stopped (RestartList). */
  async resume(): Promise<void> {
    if (!this.paused) return;
    if (!this.canPause) { this.paused = false; return; } // stopped or finished: nothing to continue
    const generation = this.generation;
    if (this.remote) { if (this.handedOver) await this.guardedRpc(generation, "V"); }
    else if (this.executing) await this.guardedSingle(generation, Cmd.RestartList);
    if (generation !== this.generation) return;
    this.pausedMs += Date.now() - this.pausedAt;
    this.paused = false;
  }

  /** Estimated marking time of the loaded job, checked against the time limit before a run starts. */
  get expectedSeconds(): number | undefined {
    return this.job ? this.estimate : undefined;
  }

  // ------------------------------------------------------------ job mode (Wi-Fi bridge runs the job)

  /** True when the link is a bridge that can run whole jobs (connects if needed). */
  private async bridgeRuns(): Promise<boolean> {
    const t = await this.connect();
    return t.jobs === true && typeof t.rpc === "function";
  }

  private bridgeOptions() {
    const o = this.options;
    return { field: o.field, source: o.source, pins: o.pins, maxPowerPct: o.maxPowerPct, initBoard: o.initBoard, frameSeconds: o.frameSeconds };
  }

  /** Polls the bridge until its job is done; the time limit leaves out paused time. */
  private async waitBridge(generation: number, timeoutMs: number, signal?: AbortSignal) {
    let started = Date.now();
    for (;;) {
      this.checkNotStopped(generation, signal);
      const q = (await this.serial(t => t.rpc!("Q"))) as { phase: string; error: string | null; progress: LmcProgress | null };
      this.remoteProgress = q.progress;
      if (q.phase === "done") return;
      if (q.phase === "error") throw new LaserDriverError(q.error === "stopped" ? "stopped" : `the laser bridge: ${q.error ?? "the job failed"}`);
      const before = Date.now();
      await sleep(Math.max(this.options.pollMs ?? 250, 50), signal);
      if (this.paused) started += Date.now() - before;
      if (Date.now() - started > timeoutMs) throw new LaserDriverError(`the laser is still marking after ${Math.round(timeoutMs / 1000)} s`);
    }
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Progress of the job being marked, or null when nothing is marked. */
  progress(): LmcProgress | null {
    if (this.operation === "marking" && this.remote) return this.remoteProgress ? { ...this.remoteProgress, paused: this.paused } : { fraction: 0, remainingSeconds: this.estimate, paused: this.paused };
    if (this.operation !== "marking" || !this.markStartedAt) return null;
    const now = Date.now();
    const elapsed = (now - this.markStartedAt - this.pausedMs - (this.paused ? now - this.pausedAt : 0)) / 1000;
    const total = Math.max(1, this.estimate);
    return { fraction: Math.max(0, Math.min(0.99, elapsed / total)), remainingSeconds: Math.max(0, total - elapsed), paused: this.paused };
  }

  /** Stop list, reset, outputs off. If the board cannot be reached, gives up at once instead of retrying each step. */
  private async haltBoard() {
    try {
      if (this.transport?.jobs || (this.remote && !this.transport)) await this.serial(t => (t.rpc ? t.rpc("S") : Promise.resolve(null)));
      await this.single(Cmd.StopExecute);
    } catch {
      return; // unreachable board: the E-stop is the only stop now; do not hang the Stop button
    }
    await this.single(Cmd.ResetList).catch(() => undefined);
    await this.outputsOff();
  }

  /**
   * Stops whatever runs and halts the board, once (keep the machine's E-stop within reach): overlapping calls share one halt, and a call after a
   * completed halt with nothing started since sends nothing. Over the Wi-Fi bridge the link is dropped first,
   * so a request stuck on a dead link fails at once; the bridge stops the board itself when its driving
   * computer goes away, and one fresh try confirms it.
   */
  async stop(): Promise<void> {
    this.generation++;
    this.paused = false;
    if (this.halting) return this.halting;
    if (this.cleanSinceHalt && !this.operation) return;
    this.halting = (async () => {
      if (this.transport?.remote) await this.drop(this.transport);
      await this.haltBoard();
      this.operation = null;
      this.cleanSinceHalt = true;
    })().finally(() => { this.halting = null; });
    return this.halting;
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
