/**
 * Laser drivers for the ComMarker Omni X.
 *
 * - `studio-footswitch`: ComMarker Studio has no API, CLI or remote start (2026-11). The Omni X ships with
 *   a foot switch that starts the job loaded in Studio, so fabPlane closes a USB relay wired in parallel
 *   with the foot switch. Studio cannot report "done", so the cycle waits the measured job time plus a margin.
 * - `lightburn`: LightBurn's documented UDP automation (send to 19840, replies on 19841): `FORCELOAD:<path>`,
 *   `START`, `STATUS` (`OK` = connected and idle, `!` = busy). Completion is observed, not timed.
 *   LightBurn has no UDP stop command; stop needs the machine's E-stop.
 * - `simulator`: for dry runs and tests.
 */
import type { LaserDriver, LaserStatus } from "./cell";
import { openSerial } from "./serial";
import type { SerialLink } from "./st3215";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("stopped"));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new Error("stopped")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export class LaserDriverError extends Error {
  override name = "LaserDriverError";
}

// ---------------------------------------------------------------- USB relay (foot-switch emulation)

/**
 * LCUS-type CH340 USB relay boards (1/2/4 channel) at 9600 baud: `A0 <channel> <state> <sum>`.
 * These are the cheapest common USB relays; their dry contact goes in parallel with the foot switch.
 */
export function lcusRelayCommand(channel: number, on: boolean): Uint8Array {
  if (!Number.isInteger(channel) || channel < 1 || channel > 8) throw new LaserDriverError("relay channel must be 1-8");
  const state = on ? 1 : 0;
  return new Uint8Array([0xa0, channel, state, (0xa0 + channel + state) & 0xff]);
}

/**
 * Arduino / ESP32 running docs/laser-cell-footswitch.ino: one ASCII byte at 9600 baud,
 * `1` = pedal down (relay closed), `0` = pedal up. The sketch answers `K` to `?` (a ping).
 */
export function arduinoRelayCommand(on: boolean): Uint8Array {
  return new Uint8Array([on ? 0x31 : 0x30]);
}

export type RelayKind = "lcus" | "arduino";

/** The foot-switch relay: `pressed` is what fabPlane last told it, not a reading of the pedal. */
export type RelayLink = {
  readonly pressed: boolean;
  set(pressed: boolean): Promise<void>;
  pulse(ms: number): Promise<void>;
  close(): Promise<void>;
};

function relayOver(link: SerialLink, command: (on: boolean) => Uint8Array): RelayLink {
  let pressed = false;
  const relay: RelayLink = {
    get pressed() {
      return pressed;
    },
    async set(on) {
      await link.write(command(on));
      pressed = on;
    },
    async pulse(ms) {
      await relay.set(true);
      try {
        await sleep(ms);
      } finally {
        await relay.set(false);
      }
    },
    async close() {
      await relay.set(false).catch(() => undefined);
      await link.close();
    },
  };
  return relay;
}

export async function openLcusRelay(port: string, channel = 1, open: typeof openSerial = openSerial): Promise<RelayLink> {
  if (!Number.isInteger(channel) || channel < 1 || channel > 8) throw new LaserDriverError("relay channel must be 1-8");
  const relay = relayOver(await open(port, 9600), on => lcusRelayCommand(channel, on));
  // Make sure the contact starts open so the laser is not triggered by a relay left on.
  await relay.set(false);
  return relay;
}

export async function openArduinoRelay(port: string, open: typeof openSerial = openSerial, bootMs = 2000): Promise<RelayLink> {
  const link = await open(port, 9600);
  // Opening the port resets most Arduinos; wait for the bootloader before talking to the sketch.
  await sleep(bootMs);
  await link.flushInput();
  await link.write(new Uint8Array([0x3f]));
  const reply = await link.read(500);
  if (!reply.includes(0x4b)) {
    await link.close();
    throw new LaserDriverError(`no answer from the foot-switch sketch on ${port}; upload docs/laser-cell-footswitch.ino and check the baud rate (9600)`);
  }
  const relay = relayOver(link, arduinoRelayCommand);
  await relay.set(false);
  return relay;
}

export function openRelay(kind: RelayKind, port: string, channel = 1): Promise<RelayLink> {
  return kind === "arduino" ? openArduinoRelay(port) : openLcusRelay(port, channel);
}

export type StudioFootswitchOptions = {
  relay: RelayLink;
  /** How long the job takes in Studio (read Studio's estimate, or time the first run). */
  markSeconds: number;
  /** Extra wait after `markSeconds` before the arm may enter (galvo settle, fume clearance). */
  marginSeconds: number;
  /** Foot-switch press length. */
  pressMs?: number;
};

export class StudioFootswitchLaser implements LaserDriver {
  readonly name = "ComMarker Studio (foot-switch relay)";
  private running = false;
  constructor(private readonly options: StudioFootswitchOptions) {}

  get relay(): RelayLink {
    return this.options.relay;
  }

  async status(): Promise<LaserStatus> {
    if (this.options.relay.pressed) return { state: "busy", detail: "foot switch held down by fabPlane; release it before a run", driver: this.name };
    return this.running
      ? { state: "busy", detail: "job started from the foot-switch relay", driver: this.name }
      : { state: "idle", detail: "relay ready; Studio's own state cannot be read, keep the job loaded and the preview off", driver: this.name };
  }

  async start(): Promise<void> {
    await this.options.relay.pulse(this.options.pressMs ?? 250);
    this.running = true;
  }

  async waitDone({ timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
    const ms = (this.options.markSeconds + this.options.marginSeconds) * 1000;
    if (ms > timeoutMs) throw new LaserDriverError(`job time ${Math.round(ms / 1000)} s is longer than the ${Math.round(timeoutMs / 1000)} s limit`);
    try {
      await sleep(ms, signal);
    } finally {
      this.running = false;
    }
  }

  /** Studio has no remote stop. The cycle freezes the arm; use the Omni X E-stop to stop the beam. */
  async stop(): Promise<void> {
    this.running = false;
    await this.options.relay.set(false).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.options.relay.close();
  }
}

// ---------------------------------------------------------------- LightBurn UDP

export const LIGHTBURN_COMMAND_PORT = 19840;
export const LIGHTBURN_REPLY_PORT = 19841;

export type UdpTransport = {
  send(text: string): Promise<void>;
  /** Next reply line, or null after `timeoutMs`. */
  receive(timeoutMs: number): Promise<string | null>;
  close(): void;
};

export async function openLightBurnUdp(host = "127.0.0.1"): Promise<UdpTransport> {
  const replies: string[] = [];
  let waiter: ((line: string) => void) | null = null;
  const socket = await Bun.udpSocket({
    port: LIGHTBURN_REPLY_PORT,
    socket: {
      data(_socket, data) {
        const line = Buffer.from(data).toString("utf8").trim();
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(line);
        } else replies.push(line);
      },
    },
  }).catch((error: unknown) => {
    throw new LaserDriverError(`could not listen on UDP ${LIGHTBURN_REPLY_PORT} for LightBurn replies (${error instanceof Error ? error.message : String(error)}); is another automation tool using it?`);
  });
  return {
    async send(text) {
      socket.send(text, LIGHTBURN_COMMAND_PORT, host);
    },
    receive(timeoutMs) {
      const queued = replies.shift();
      if (queued !== undefined) return Promise.resolve(queued);
      return new Promise(resolve => {
        const timer = setTimeout(() => { waiter = null; resolve(null); }, timeoutMs);
        waiter = line => { clearTimeout(timer); resolve(line); };
      });
    },
    close() {
      socket.close();
    },
  };
}

export class LightBurnLaser implements LaserDriver {
  readonly name = "LightBurn (UDP)";
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly udp: UdpTransport, private readonly options: { pollMs?: number; startTimeoutMs?: number } = {}) {}

  /** One command, one reply; serialised so replies cannot cross. */
  command(text: string, timeoutMs = 2000): Promise<string | null> {
    const run = async () => {
      while ((await this.udp.receive(0)) !== null) { /* drop stale replies */ }
      await this.udp.send(text);
      return this.udp.receive(timeoutMs);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async status(): Promise<LaserStatus> {
    const ping = await this.command("PING");
    if (ping === null) return { state: "offline", detail: "LightBurn is not answering on UDP 19840; open LightBurn", driver: this.name };
    if (ping !== "OK") return { state: "error", detail: "LightBurn has a dialog open; close it", driver: this.name };
    const status = await this.command("STATUS");
    if (status === "OK") return { state: "idle", detail: "connected and ready", driver: this.name };
    if (status === "!") return { state: "busy", detail: "LightBurn is running a job", driver: this.name };
    return { state: "error", detail: "the laser is not connected in LightBurn", driver: this.name };
  }

  async load(jobPath: string): Promise<void> {
    if ((await this.command(`FORCELOAD:${jobPath}`, 10_000)) !== "OK") throw new LaserDriverError(`LightBurn could not load ${jobPath}`);
  }

  async start(): Promise<void> {
    if ((await this.command("START")) !== "OK") throw new LaserDriverError("LightBurn refused START (laser busy, disconnected or a dialog is open)");
  }

  async waitDone({ timeoutMs, signal }: { timeoutMs: number; signal?: AbortSignal }): Promise<void> {
    const poll = this.options.pollMs ?? 500;
    const started = Date.now();
    let seenBusy = false;
    let idleStreak = 0;
    for (;;) {
      if (signal?.aborted) throw new LaserDriverError("stopped");
      const s = await this.command("STATUS");
      if (s === "!") { seenBusy = true; idleStreak = 0; }
      else if (s === "OK") idleStreak++;
      else if (s === null) throw new LaserDriverError("LightBurn stopped answering while the job was running");
      else throw new LaserDriverError("LightBurn lost the laser connection while marking");
      // Two idle polls in a row after having seen busy = finished. Never seen busy = it did not start.
      if (seenBusy && idleStreak >= 2) return;
      if (!seenBusy && Date.now() - started > (this.options.startTimeoutMs ?? 8000)) {
        throw new LaserDriverError("LightBurn never reported the job as running; check that Start runs the job and not only the frame preview");
      }
      if (Date.now() - started > timeoutMs) throw new LaserDriverError(`job still running after ${Math.round(timeoutMs / 1000)} s`);
      await sleep(poll, signal).catch(() => undefined);
    }
  }

  /** LightBurn's UDP interface has no stop command; the cycle freezes the arm and asks for the E-stop. */
  async stop(): Promise<void> {}

  async close(): Promise<void> {
    this.udp.close();
  }
}

// ---------------------------------------------------------------- simulator

export class SimulatedLaser implements LaserDriver {
  readonly name = "Simulator";
  private busyUntil = 0;
  readonly log: string[] = [];
  constructor(private readonly markMs = 1500) {}

  async status(): Promise<LaserStatus> {
    return Date.now() < this.busyUntil ? { state: "busy", detail: "simulated marking", driver: this.name } : { state: "idle", detail: "simulated laser", driver: this.name };
  }
  async load(path: string) { this.log.push(`load ${path}`); }
  async frame(seconds: number, signal?: AbortSignal) { this.log.push(`frame ${seconds}s`); await sleep(Math.min(seconds * 1000, 200), signal); }
  async start() { this.log.push("start"); this.busyUntil = Date.now() + this.markMs; }
  async waitDone({ signal }: { timeoutMs: number; signal?: AbortSignal }) {
    while (Date.now() < this.busyUntil) await sleep(50, signal);
    this.log.push("done");
  }
  async stop() { this.log.push("stop"); this.busyUntil = 0; }
}
