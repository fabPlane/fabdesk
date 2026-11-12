/**
 * Adopt a board candidate made by a board workflow stage (edit, last mile, review fixes) into a
 * project's saved board as one KiCad commit.
 *
 * Two private headless `kicad-cli api-server` processes: one holds the target board (the project's
 * saved file), one the candidate. The delta target → candidate is computed item by item and applied on
 * the target inside a single BeginCommit/EndCommit, then the target is saved and read back.
 *
 * Comparison ignores what KiCad regenerates on every load: the per-session board parent id, and the
 * KIIDs of footprint children (pads, fields, graphics) that the file does not store. Top-level pads are
 * skipped because footprint updates carry them. Measured on C6 (318 footprints, 5047 tracks): a
 * one-part move with 24 tracks gives an identical A1-A9 to the file path (io-c6/work/ipc01).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KiCad, type Board } from "@fp-pcb/client";
import { NngIpcTransport, NngWsTransport } from "@fp-pcb/client/transport";
import { ToolError, type BoardAdoptResult, type KicadCli } from "@fabdesk/tools";

type AnyItem = { id: string; typeName: string; toJson(): unknown };
type Summary = BoardAdoptResult["delta"];

const sha256 = async (path: string) => createHash("sha256").update(await readFile(path)).digest("hex");

/** Item JSON with regenerated ids removed (top-level id kept as the key). */
export function normalisedItemJson(item: AnyItem): string {
  const strip = (value: unknown, top: boolean): unknown => {
    if (Array.isArray(value)) return value.map((x) => strip(x, false));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        if (k === "parent" || (k === "id" && !top)) continue;
        out[k] = strip(v, false);
      }
      return out;
    }
    return value;
  };
  return JSON.stringify(strip(item.toJson(), true));
}

const keyOf = (item: AnyItem) => `${item.typeName}:${item.id}`;

async function snapshot(board: Board): Promise<Map<string, AnyItem>> {
  const items = (await board.getAllItems()) as unknown as AnyItem[];
  const map = new Map<string, AnyItem>();
  for (const item of items) if (item.id && item.typeName !== "KOT_PCB_PAD") map.set(keyOf(item), item);
  return map;
}

export function diffItems(a: Map<string, AnyItem>, b: Map<string, AnyItem>) {
  const removed: AnyItem[] = [];
  const added: AnyItem[] = [];
  const changed: AnyItem[] = [];
  for (const [k, item] of a) if (!b.has(k)) removed.push(item);
  for (const [k, item] of b) {
    const old = a.get(k);
    if (!old) added.push(item);
    else if (normalisedItemJson(old) !== normalisedItemJson(item)) changed.push(item);
  }
  const count = (xs: AnyItem[]) =>
    xs.reduce<Record<string, number>>((o, x) => ((o[x.typeName] = (o[x.typeName] ?? 0) + 1), o), {});
  const summary: Summary = { removed: count(removed), added: count(added), changed: count(changed) };
  return { removed, added, changed, summary };
}

type Held = { procs: ChildProcess[]; dirs: string[]; transports: Array<NngIpcTransport | NngWsTransport> };

/** Unused loopback TCP port, released again for the KiCad child (as fab_pcb's bridge allocates its ws port). */
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((e) => (e ? reject(e) : port ? resolvePort(port) : reject(new Error("no free loopback port"))));
    });
  });
}

/**
 * Where the private api-server listens: a Unix socket in the adopt's temp dir, or on Windows (no Unix sockets for
 * KiCad's nng IPC) a loopback WebSocket, the transport fab_pcb's bridge uses there (`KICAD_SOCKET_TRANSPORT` = ws).
 */
export function apiServerEndpoint(platform: NodeJS.Platform, dir: string, port: number): string {
  return platform === "win32" ? `ws://127.0.0.1:${port}/kicad/adopt-${port}` : join(dir, "api.sock");
}

async function serve(cli: string, board: string, held: Held, signal?: AbortSignal) {
  const dir = await mkdtemp(join(tmpdir(), "fabdesk-adopt-"));
  held.dirs.push(dir);
  const win = process.platform === "win32";
  const endpoint = apiServerEndpoint(process.platform, dir, win ? await freePort() : 0);
  // own process group (POSIX): a packaged kicad-cli is often a shell wrapper, and the server under it must go too;
  // on Windows the tree is killed with taskkill /T instead
  const proc = spawn(cli, ["api-server", "--socket", endpoint, board], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: !win,
    windowsHide: true,
  });
  held.procs.push(proc);
  let log = "";
  proc.stdout?.on("data", (b: Buffer) => (log += b));
  proc.stderr?.on("data", (b: Buffer) => (log += b));
  proc.on("error", (e) => (log += `\n${e.message}`));
  const couldNotOpen = () =>
    new ToolError(
      `KiCad could not open ${board}: ${log.trim().slice(-400) || "no output"}. ` +
        "The selected kicad-cli must read this board's file format (Settings → KiCad CLI).",
      "precondition",
    );
  let transport: NngIpcTransport | NngWsTransport;
  if (win) {
    // no socket file to wait for: dial with retries until KiCad listens, failing as soon as the process exits
    transport = new NngWsTransport({
      url: endpoint,
      defaultTimeoutMs: 600_000,
      connectTimeoutMs: 120_000,
      reconnect: { initialDelayMs: 50, maxDelayMs: 500, maxAttempts: 600 },
    });
    held.transports.push(transport);
    const exited = new Promise<never>((_, reject) => {
      const fail = () => reject(couldNotOpen());
      if (proc.exitCode !== null) fail();
      proc.once("exit", fail);
      proc.once("error", fail);
    });
    const aborted = new Promise<never>((_, reject) =>
      signal?.addEventListener("abort", () => reject(new ToolError("adopt cancelled", "cancelled")), { once: true }),
    );
    exited.catch(() => {});
    aborted.catch(() => {});
    await Promise.race([transport.ready(), exited, aborted]);
  } else {
    for (let i = 0; ; i++) {
      if (signal?.aborted) throw new ToolError("adopt cancelled", "cancelled");
      if (await stat(endpoint).then((s) => s.isSocket(), () => false)) break;
      if (proc.exitCode !== null || i > 1200) throw couldNotOpen();
      await new Promise((z) => setTimeout(z, 100));
    }
    transport = new NngIpcTransport({ path: endpoint, defaultTimeoutMs: 600_000, connectTimeoutMs: 120_000 });
    held.transports.push(transport);
    await transport.ready();
  }
  const kicad = await KiCad.connect(transport, { clientName: "fabdesk/workflow-adopt" });
  const doc = (await kicad.currentBoard()) ?? (await kicad.openBoard(board));
  return { doc };
}

/**
 * Kills the server and whatever it started: the POSIX process group (signalled even when its leader already exited,
 * since a wrapper may leave the server behind), or on Windows the process tree (`taskkill /T /F`; there is no
 * graceful signal, so SIGTERM and SIGKILL both force it).
 */
export function killTree(
  p: Pick<ChildProcess, "pid">,
  sig: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  run: (cmd: string, args: string[]) => void = (cmd, args) => {
    spawn(cmd, args, { stdio: "ignore", windowsHide: true }).on("error", () => {});
  },
): void {
  if (p.pid === undefined) return;
  if (platform === "win32") {
    run("taskkill", ["/PID", String(p.pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-p.pid, sig);
  } catch {
    // group already gone
  }
}

/** Stops every server this adopt started (whole process groups or trees, SIGKILL after 3 s) and removes its temp dirs. */
export async function releaseHeld(held: Held): Promise<void> {
  await Promise.all(held.transports.map((t) => t.close().catch(() => {})));
  // the group is signalled even when its leader already exited: a wrapper may leave the server behind
  for (const p of held.procs) killTree(p, "SIGTERM");
  const live = held.procs.filter((p) => p.exitCode === null && p.signalCode === null);
  await Promise.all(
    live.map(
      (p) =>
        new Promise<void>((done) => {
          const t = setTimeout(() => (killTree(p, "SIGKILL"), done()), 3000);
          p.once("exit", () => (clearTimeout(t), done()));
        }),
    ),
  );
  await Promise.all(held.dirs.map((d) => rm(d, { recursive: true, force: true })));
}

export async function adoptBoard(input: {
  target: string;
  candidate: string;
  cli: KicadCli;
  signal?: AbortSignal;
}): Promise<BoardAdoptResult> {
  const timings: Record<string, number> = {};
  const lap = (k: string, t0: number) => (timings[k] = Math.round(performance.now() - t0));
  const held: Held = { procs: [], dirs: [], transports: [] };
  const before = await sha256(input.target);
  try {
    let t0 = performance.now();
    const target = await serve(input.cli.path, input.target, held, input.signal);
    const candidate = await serve(input.cli.path, input.candidate, held, input.signal);
    lap("start", t0);
    t0 = performance.now();
    const [a, b] = await Promise.all([snapshot(target.doc), snapshot(candidate.doc)]);
    lap("read", t0);
    const d = diffItems(a, b);
    if (input.signal?.aborted) throw new ToolError("adopt cancelled", "cancelled");
    t0 = performance.now();
    if (d.removed.length || d.added.length || d.changed.length) {
      await target.doc.commit("fabdesk: adopt board workflow candidate", async (tx) => {
        if (d.removed.length) await tx.delete(d.removed.map((x) => x.id));
        if (d.added.length) await tx.create(d.added as never[]);
        if (d.changed.length) await tx.update(d.changed as never[]);
      });
      lap("commit", t0);
      t0 = performance.now();
      await target.doc.save();
      lap("save", t0);
    }
    const residual = diffItems(await snapshot(target.doc), b).summary;
    return {
      delta: d.summary,
      residual,
      targetSha256Before: before,
      targetSha256After: await sha256(input.target),
      timingsMs: timings,
      kicadCli: input.cli.path,
    };
  } finally {
    await releaseHeld(held);
  }
}
