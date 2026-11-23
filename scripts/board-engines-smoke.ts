/**
 * Board engines smoke: the parts of the board workflow that touch the host OS, run for real on whatever machine runs
 * this (Linux, macOS, Windows). The unit tests cover the same code with fake command output; this proves the real
 * commands and paths. CI runs it on all three (`.github/workflows/board-engines.yml`).
 *
 *   bun scripts/board-engines-smoke.ts [--out report.json] [--data-dir DIR] [--keep] [--skip-krt]
 *
 * Checks, each a row of the JSON report (printed to stdout, and written to --out):
 * - memory: `sysinfo.hostMemory()` reads the platform source (Linux /proc, macOS vm_stat, Windows os) and gives
 *   0 < available <= total; the resource governor's `sampleHost` sees the same and can statfs the temp dir. On macOS the
 *   raw `vm_stat` / `sysctl vm.swapusage` output goes into the report (the unit-test sample was written from memory).
 * - process: `sysinfo.processRunning` finds this Bun process by name and not a made-up one; `treeRss` of this process.
 * - nodeRun: the layout engines' process runner runs a real child at low priority (priority read back in the child),
 *   flushes the log before it resolves, writes stdout to a file, and kills on timeout with 124.
 * - customCheck: a review custom check runs through the platform shell (`/bin/sh`, Windows `cmd.exe`).
 * - krtInstall: KiCadRoutingTools installs through the router registry (`install("krt")`) into a temp data dir.
 * - krtImport: the venv Python from `layout.krtPaths` imports numpy, scipy, shapely and the Rust `grid_router`.
 * - krtRoute: `layout.routeKrt` routes `packages/board-workflow/test/fixtures/krt-smoke.kicad_pcb` (two nets, six pads,
 *   both sides) and the routed board has new copper and no failed nets.
 *
 * Exits 1 when any check fails. Needs network for the KRT download (and uv's or pip's package downloads).
 */
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { freemem, getPriority, tmpdir, totalmem } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { layout, sysinfo, type Requirements, type ReviewCtx } from "../packages/board-workflow/src/index";
import { checkCustom } from "../packages/board-workflow/src/review/checks";
import { sampleHost } from "../packages/tools/src/resources";
import { createRouterRegistry } from "../packages/tools/src/routers/registry";
import { findUv, krtRootProblem } from "../packages/tools/src/routers/krt";

const { values: a } = parseArgs({
  options: {
    out: { type: "string" },
    "data-dir": { type: "string" },
    keep: { type: "boolean", default: false },
    "skip-krt": { type: "boolean", default: false },
  },
});

const repo = resolve(import.meta.dir, "..");
const FIXTURE = join(repo, "packages", "board-workflow", "test", "fixtures", "krt-smoke.kicad_pcb");
const work = await mkdtemp(join(tmpdir(), "board-engines-smoke-"));
const dataDir = a["data-dir"] ? resolve(a["data-dir"]) : join(work, "data");

type Row = { name: string; ok: boolean; ms: number; detail: Record<string, unknown>; error?: string };
const rows: Row[] = [];

class Fail extends Error {
  constructor(message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
  }
}
const expect = (cond: unknown, message: string, detail: Record<string, unknown> = {}) => {
  if (!cond) throw new Fail(message, detail);
};

async function check(name: string, fn: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown> | null> {
  const t0 = performance.now();
  process.stderr.write(`[smoke] ${name} ...\n`);
  try {
    const detail = await fn();
    rows.push({ name, ok: true, ms: Math.round(performance.now() - t0), detail });
    process.stderr.write(`[smoke] ${name} ok\n`);
    return detail;
  } catch (e) {
    const err = e as Error;
    rows.push({ name, ok: false, ms: Math.round(performance.now() - t0), detail: e instanceof Fail ? e.detail : {}, error: err.stack ?? String(err) });
    process.stderr.write(`[smoke] ${name} FAILED: ${err.message}\n`);
    return null;
  }
}

const expectedSource: Partial<Record<NodeJS.Platform, sysinfo.HostMemory["source"]>> = { linux: "proc", darwin: "vm_stat", win32: "os" };
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10_000 });
  return r.error ? `(${r.error.message})` : r.stdout;
};

// ---------------------------------------------------------------- host memory

await check("memory", async () => {
  const m = await sysinfo.hostMemory();
  const sample = await sampleHost([work]);
  const detail: Record<string, unknown> = { hostMemory: m, osFreeGiB: freemem() / 1024 ** 3, osTotalGiB: totalmem() / 1024 ** 3, sampleHost: sample };
  if (process.platform === "darwin") {
    detail["vm_stat"] = run("vm_stat", []);
    detail["swapusage"] = run("sysctl", ["-n", "vm.swapusage"]);
  }
  const want = expectedSource[process.platform];
  expect(!want || m.source === want, `source ${m.source}, expected ${want} on ${process.platform}`, detail);
  expect(m.totalGiB > 0, "total memory is 0", detail);
  expect(m.availableGiB > 0, "available memory is 0", detail);
  expect(m.availableGiB <= m.totalGiB, `available ${m.availableGiB} GiB > total ${m.totalGiB} GiB`, detail);
  expect(m.swapUsedGiB >= 0, "negative swap", detail);
  expect(sample.memAvailableGiB === m.availableGiB || Math.abs(sample.memAvailableGiB - m.availableGiB) < 2, "sampleHost disagrees with hostMemory", detail);
  // statfs gives the governor its disk-space check; without it the check is skipped silently
  expect(sample.disk.length === 1 && sample.disk[0]!.freeGiB > 0, `sampleHost could not statfs ${work}`, detail);
  return detail;
});

// ---------------------------------------------------------------- processes

await check("process", async () => {
  const self = basename(process.execPath).replace(/\.exe$/i, "");
  const running = await sysinfo.processRunning(self);
  const bogus = await sysinfo.processRunning("fabdesk-no-such-process-42");
  const rss = await sysinfo.treeRss(process.pid);
  const detail = { self, running, bogus, treeRssMiB: Math.round(rss / 1024 ** 2), tracemakerBusy: await sysinfo.processRunning("tracemaker") };
  expect(running, `processRunning("${self}") is false while this process runs`, detail);
  expect(!bogus, "processRunning finds a process that does not exist", detail);
  // Windows has no parent links without WMI, so treeRss reports 0 there by design
  if (process.platform !== "win32") expect(rss > 0, "treeRss of this process is 0", detail);
  return detail;
});

// ---------------------------------------------------------------- nodeRun

await check("nodeRun", async () => {
  const dir = join(work, "noderun");
  await mkdir(dir, { recursive: true });
  const log = join(dir, "run.log");
  const out = join(dir, "stdout.txt");
  // the child waits before reading its priority: on Windows the runner lowers it just after spawn
  const child = `setTimeout(() => { console.log(JSON.stringify({ priority: require("node:os").getPriority() })); console.error("to-the-log"); }, 400)`;
  const lp = layout.lowPriority([process.execPath]);
  const r = await layout.nodeRun([process.execPath, "-e", child], { log, stdout: out, timeoutMs: 60_000 });
  const logText = await readFile(log, "utf8");
  const outText = await readFile(out, "utf8");
  const priority = (JSON.parse(outText.trim().split("\n").at(-1) || "{}") as { priority?: number }).priority;
  const t = await layout.nodeRun([process.execPath, "-e", "setTimeout(() => {}, 30000)"], { log: join(dir, "timeout.log"), timeoutMs: 500 });
  const timeoutLog = await readFile(join(dir, "timeout.log"), "utf8");
  const detail = { exit: r.code, wallS: r.wallS, via: lp.argv[0] === process.execPath ? "os.setPriority" : lp.argv[0], priority, parentPriority: getPriority(), log: logText.trim(), stdout: outText.trim(), timeoutExit: t.code, timeoutWallS: t.wallS };
  expect(r.code === 0, `exit ${r.code}`, detail);
  expect(logText.includes("to-the-log"), "stderr was not flushed to the log when nodeRun resolved", detail);
  expect(priority !== undefined, "the child printed no priority to the stdout file", detail);
  // `nice -n 5` is relative to this process; os.setPriority sets 5 (POSIX) or BELOW_NORMAL, which reads back as 10 (Windows)
  const want = process.platform === "win32" ? 10 : lp.setPriority === null ? Math.min(19, getPriority() + 5) : 5;
  expect(priority === want, `child priority ${priority}, expected ${want}`, detail);
  expect(t.code === 124 && timeoutLog.includes("TIMEOUT"), `timeout gave exit ${t.code}`, detail);
  return detail;
});

// ---------------------------------------------------------------- custom check through the platform shell

await check("customCheck", async () => {
  const dir = join(work, "review");
  await mkdir(join(dir, "out"), { recursive: true });
  const json = `[{"rule":"SMOKE","severity":"note","claim":"platform shell ran"}]`;
  const runLine = process.platform === "win32" ? `echo ${json}` : `echo '${json}'`;
  const ctx = {
    project: { dir, name: "smoke", pcb: join(dir, "smoke.kicad_pcb"), sch: join(dir, "smoke.kicad_sch"), cfg: { custom: [{ name: "smoke", run: runLine }] } },
    env: { trustCustom: true },
    out: join(dir, "out"),
  } as unknown as ReviewCtx;
  const r = await checkCustom(ctx);
  const detail = { status: r.status, detail: r.detail, claims: r.findings.map((f) => f.claim) };
  expect(r.status !== "error" && r.findings.length === 1 && r.findings[0]!.claim === "platform shell ran", "custom check did not run through the platform shell", detail);
  return detail;
});

// ---------------------------------------------------------------- KiCadRoutingTools

if (!a["skip-krt"]) {
  let krtRoot: string | null = null;
  await check("krtInstall", async () => {
    const env = { ...process.env };
    delete env["FABDESK_KRT_DIR"];
    const registry = createRouterRegistry({ home: dataDir, env });
    const uvBefore = findUv({ env });
    const lines: string[] = [];
    const snap = await registry.install("krt", {
      onLine: (line) => {
        lines.push(line);
        process.stderr.write(`[smoke]   ${line}\n`);
      },
    });
    const detail: Record<string, unknown> = { dataDir, uvBefore, installLog: lines.slice(-40), state: snap.state, ready: snap.ready, version: snap.versionInstalled ?? snap.version, path: snap.path, notice: snap.notice, error: snap.error, hint: snap.installHint };
    expect(snap.state === "installed" && snap.ready && snap.path, `KRT install: ${snap.state}${snap.error ? ` (${snap.error})` : ""}`, detail);
    const problem = krtRootProblem(snap.path!);
    expect(problem === null, `installed KRT is not runnable: ${problem}`, detail);
    krtRoot = snap.path!;
    return detail;
  });

  if (krtRoot) {
    const root: string = krtRoot;
    await check("krtImport", async () => {
      const k = layout.krtPaths(root);
      const code = [
        "import sys, json, platform",
        "sys.path.insert(0, sys.argv[1])",
        "import numpy, scipy, shapely, grid_router",
        "print(json.dumps({'python': platform.python_version(), 'executable': sys.executable, 'numpy': numpy.__version__, 'scipy': scipy.__version__, 'shapely': shapely.__version__, 'grid_router': getattr(grid_router, '__version__', '?')}))",
      ].join("\n");
      const r = spawnSync(k.python[0]!, [...k.python.slice(1), "-c", code, join(k.plugins, "rust_router")], { encoding: "utf8", timeout: 120_000 });
      const detail: Record<string, unknown> = { python: k.python[0], exit: r.status, stderr: (r.stderr ?? "").slice(-2000) };
      expect(r.status === 0, `import check exit ${r.status}${r.error ? ` (${r.error.message})` : ""}`, detail);
      return { ...detail, ...(JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1)!) as Record<string, unknown>) };
    });

    await check("krtRoute", async () => {
      const placed = join(work, "placed");
      await mkdir(placed, { recursive: true });
      await copyFile(FIXTURE, join(placed, "smoke.kicad_pcb"));
      const out = join(work, "route");
      const unsupported = async (): Promise<never> => {
        throw new Error("not used by the smoke");
      };
      const host: layout.LayoutHost = {
        tools: { krt: root, tracemaker: null, kicadCli: null },
        spawn: layout.nodeRun,
        courtyardDrc: unsupported,
        scoreDrc: unsupported,
        memAvailableGiB: async () => (await sysinfo.hostMemory()).availableGiB,
        diskFreeGiB: async () => 0,
        log: (line) => process.stderr.write(`[smoke]   ${line}\n`),
      };
      // Match the real acceptance contract; do not opt the smoke into via-in-pad.
      const manufacturingRules: Requirements["acceptance"]["manufacturing_rules"] = {
        adopted: {
          min_track_width: 0.15,
          min_clearance: 0.15,
          default_class: { track_width: 0.15, clearance: 0.15, via_diameter: 0.5, via_drill: 0.2 },
        },
        scoped_rules: [],
        basis: "smoke fixture defaults",
        native_project_rules: false,
        native_project_rules_basis: "isolated smoke fixture",
      };
      const req = { acceptance: {
        manufacturing_rules: manufacturingRules,
        net_classes: { classes: {} },
        stack_policy: { copper_layers: ["F.Cu", "B.Cu"], no_track_layers: [] },
      } } as unknown as Requirements;
      const plan = { note: "smoke: one route stage on both layers", stages: [{ name: "route", tool: "route", args: ["--layers", "@layers"] }] } as layout.KrtPlan;
      const rec = await layout.routeKrt(host, { placed, out, plan, stem: "smoke", req, score: false, budgetMs: 10 * 60_000 });
      const copper = (t: string) => (t.match(/\((segment|via|arc)\s/g) ?? []).length;
      const before = copper(await readFile(FIXTURE, "utf8"));
      const routedPath = join(out, "routed-native-names.kicad_pcb");
      const routed = await readFile(routedPath, "utf8").catch(() => "");
      const stage = rec.stages[0] ?? {};
      const log = await readFile(join(out, "s1-route.log"), "utf8").catch(() => "");
      const detail: Record<string, unknown> = { record: rec, copperBefore: before, copperAfter: copper(routed), logTail: log.slice(-3000) };
      expect(!rec.error, `routeKrt: ${rec.error}`, detail);
      const policy = stage["viaInPadPolicy"] as { allowed?: boolean; clearanceMm?: number } | undefined;
      expect(policy?.allowed === false && policy.clearanceMm === 0.15, "default via-in-pad exclusion was not enforced", detail);
      expect(stage["exit"] === 0, `route stage exit ${String(stage["exit"])}`, detail);
      expect(copper(routed) > before, "the routed board has no new copper", detail);
      const failed = (stage["failed_single"] as unknown[] | undefined) ?? [];
      const summary = /JSON_SUMMARY: (\{.*\})/.exec(log);
      const s = summary ? (JSON.parse(summary[1]!) as { failed?: number; successful?: number }) : null;
      detail["summary"] = s && { successful: s.successful, failed: s.failed };
      expect(failed.length === 0 && (s?.failed ?? 0) === 0, "KRT reports failed nets", detail);
      delete detail["logTail"];
      return detail;
    });
  }
}

// ---------------------------------------------------------------- report

const report = {
  ok: rows.every((r) => r.ok),
  platform: process.platform,
  arch: process.arch,
  bun: Bun.version,
  at: new Date().toISOString(),
  failed: rows.filter((r) => !r.ok).map((r) => r.name),
  checks: rows,
};
const text = JSON.stringify(report, null, 2) + "\n";
process.stdout.write(text);
if (a.out) {
  await mkdir(dirname(resolve(a.out)), { recursive: true });
  await writeFile(a.out, text);
}
if (!a.keep) await rm(work, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
else process.stderr.write(`[smoke] kept ${work}\n`);
process.exit(report.ok ? 0 : 1);
