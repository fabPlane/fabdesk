#!/usr/bin/env bun
/**
 * VAIO CM5 carrier B2.23 benchmark fixture.
 *
 *   bun run scripts/bench/vaio-b223.ts [--router freerouting|capacity] [--scenario repair|full]
 *       [--repeat 1] [--timeout-ms 120000] [--pours polygon|omit] [--no-daemon] [--json <out>]
 *
 * 1. verifies the pinned carrier commit + board SHA-256 and copies the board out of git,
 * 2. creates or refreshes the Fabdesk project `~/Fabdesk/vaio-b223-bench` -- through the running
 *    daemon (daemon.json) when there is one, so the app sees the project and the Route Cinema
 *    gets the frames; else directly on disk,
 * 3. imports the board (project_import_kicad), writes fabdesk.json (6 layers, netclass rules),
 * 4. runs the route benchmark (default: one `repair` run with js_autorouter/freerouting),
 * 5. prints a short report. See docs/benchmarks.md.
 *
 * Nothing here launches KiCad and nothing from the board enters this repository.
 */
import { homedir } from "node:os";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchVaioBoard, VAIO_B223 } from "./vaio-b223-source";

type Flags = Record<string, string | boolean>;
function parse(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--"))
      out[a.slice(2)] = argv[++i]!;
    else out[a.slice(2)] = true;
  }
  return out;
}
const flags = parse(process.argv.slice(2));
const str = (k: string): string | undefined =>
  typeof flags[k] === "string" ? (flags[k] as string) : undefined;
const router = (str("router") ?? "freerouting") as "freerouting" | "capacity";
const scenario = (str("scenario") ?? "repair") as "repair" | "full";
const repeat = Number(str("repeat") ?? 1);
const timeoutMs = Number(str("timeout-ms") ?? 120_000);
const pours = (str("pours") ?? "polygon") as "polygon" | "omit";
const PROJECT_NAME = "vaio-b223-bench";
const repoRoot = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const projectsDir = process.env["FABDESK_PROJECTS_DIR"] ?? join(homedir(), "Fabdesk");
const projectDir = join(projectsDir, PROJECT_NAME);
const log = (s: string) => process.stderr.write(`${s}\n`);

/* ---------- daemon discovery ---------- */
type Handshake = {
  port: number;
  host: string;
  token: string;
  channel: string;
  pid: number;
  version: string;
};
async function findDaemon(): Promise<{
  url: string;
  token: string;
  channel: string;
  version: string;
} | null> {
  if (flags["no-daemon"]) return null;
  const candidates = [
    ...(process.env["FABDESK_HOME"] ? [join(process.env["FABDESK_HOME"], "daemon.json")] : []),
    join(homedir(), "Library", "Application Support", "@fabdesk", "desktop", "daemon.json"),
    join(
      process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
      "@fabdesk",
      "desktop",
      "daemon.json",
    ),
  ];
  for (const path of candidates) {
    let hs: Handshake;
    try {
      hs = JSON.parse(await readFile(path, "utf8")) as Handshake;
    } catch {
      continue;
    }
    const url = `http://${hs.host}:${hs.port}`;
    try {
      const health = (await (await fetch(`${url}/health`)).json()) as {
        ok?: boolean;
        channel?: string;
        version?: string;
      };
      if (health.ok)
        return {
          url,
          token: hs.token,
          channel: health.channel ?? hs.channel,
          version: health.version ?? hs.version,
        };
    } catch {
      // stale handshake
    }
  }
  return null;
}

async function api<T>(
  d: { url: string; token: string },
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`${d.url}${path}`, {
    ...rest,
    headers: {
      authorization: `Bearer ${d.token}`,
      ...(json !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}

async function waitJob(
  d: { url: string; token: string },
  jobId: string,
): Promise<{ status: string; result?: unknown; error?: string | null; note?: string | null }> {
  let lastNote = "";
  for (;;) {
    const job = await api<{
      status: string;
      result?: unknown;
      error?: string | null;
      note?: string | null;
    }>(d, `/jobs/${jobId}`);
    if (job.note && job.note !== lastNote) {
      lastNote = job.note;
      log(`  [${jobId.slice(0, 10)}] ${job.note}`);
    }
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") return job;
    await new Promise((r) => setTimeout(r, 750));
  }
}

/* ---------- main ---------- */
const t0 = performance.now();
log(
  `VAIO B2.23 fixture: ${VAIO_B223.repo} @ ${VAIO_B223.commit.slice(0, 12)} ${VAIO_B223.pcbPath}`,
);
const scratch = await mkdtemp(join(tmpdir(), "fabdesk-vaio-b223-"));
const board = await fetchVaioBoard(scratch);
log(`board verified: sha256 ${board.sha256} (${board.bytes} bytes) -> ${board.pcbPath}`);

const daemon = await findDaemon();
let importText: string;
let importJson: Record<string, unknown> | null = null;
let projectId: string;
let projectPath = projectDir;
let daemonTools = new Set<string>();
if (daemon) {
  log(`daemon: ${daemon.url} (v${daemon.version}, channel ${daemon.channel})`);
  const projects = await api<Array<{ id: string; name: string; path: string }>>(
    daemon,
    "/projects",
  );
  let project = projects.find((p) => p.name === PROJECT_NAME || p.path === projectDir);
  if (!project) {
    project = await api<{ id: string; name: string; path: string }>(daemon, "/projects", {
      method: "POST",
      json: { name: PROJECT_NAME },
    });
    log(`created project ${project.id} at ${project.path}`);
  } else log(`project ${project.id} at ${project.path}`);
  projectId = project.id;
  projectPath = project.path;
  daemonTools = new Set(
    (await api<Array<{ name: string }>>(daemon, "/tools/manifest")).map((t) => t.name),
  );
} else {
  log(
    "no running daemon found; working directly on disk (start the dev app to see the project and its frames)",
  );
  projectId = `prj_${PROJECT_NAME}`;
}

if (daemon && daemonTools.has("project_import_kicad")) {
  const t1 = performance.now();
  const started = await api<{ jobId: string }>(daemon, "/tools/project_import_kicad", {
    method: "POST",
    json: { project: projectId, args: { path: board.pcbPath, strict: true } },
  });
  const job = await waitJob(daemon, started.jobId);
  if (job.status !== "done") throw new Error(`import failed: ${job.error ?? job.status}`);
  const out = job.result as { text?: string; json?: { report?: Record<string, unknown> } };
  importText = out.text ?? "";
  importJson = out.json?.report ?? null;
  log(`import via daemon in ${Math.round(performance.now() - t1)} ms`);
} else {
  if (daemon)
    log(
      "the running daemon predates project_import_kicad (restart the dev app to pick it up); importing on disk into its project directory",
    );
  const { importKicadPcb } = await import("../../packages/kicad/src/index");
  const { PROJECT_FILES, writeJson } = await import("../../packages/tools/src/index");
  const { ProjectManifest } = await import("../../packages/protocol/src/index");
  await mkdir(projectPath, { recursive: true });
  const manifestPath = join(projectPath, PROJECT_FILES.manifest);
  let manifest = await readFile(manifestPath, "utf8")
    .then((t) => ProjectManifest.parse(JSON.parse(t)))
    .catch(() => null);
  const ts = new Date().toISOString();
  manifest ??= ProjectManifest.parse({
    schema: 1,
    id: projectId,
    name: PROJECT_NAME,
    createdAt: ts,
    updatedAt: ts,
    board: { layers: 6 },
    router: "capacity",
  });
  projectId = manifest.id;
  for (const sub of [
    PROJECT_FILES.sketches,
    PROJECT_FILES.renders,
    PROJECT_FILES.reports,
    PROJECT_FILES.exports,
    PROJECT_FILES.runs,
  ])
    await mkdir(join(projectPath, sub), { recursive: true });
  const t1 = performance.now();
  const { circuitJson, report } = await importKicadPcb({
    pcbPath: board.pcbPath,
    projectName: PROJECT_NAME,
  });
  await writeJson(join(projectPath, PROJECT_FILES.circuitJson), circuitJson);
  await rm(join(projectPath, PROJECT_FILES.routedJson), { force: true });
  await writeJson(join(projectPath, PROJECT_FILES.reports, "import.json"), report);
  const rules = report.designRules;
  manifest = ProjectManifest.parse({
    ...manifest,
    updatedAt: ts,
    board: {
      layers: report.layers.copperCount,
      ...(report.board.widthMm ? { widthMm: report.board.widthMm } : {}),
      ...(report.board.heightMm ? { heightMm: report.board.heightMm } : {}),
      ...(rules
        ? {
            rules: {
              ...(rules.traceWidthMm !== undefined ? { traceWidthMm: rules.traceWidthMm } : {}),
              ...(rules.clearanceMm !== undefined ? { clearanceMm: rules.clearanceMm } : {}),
              ...(rules.viaDrillMm !== undefined ? { viaDrillMm: rules.viaDrillMm } : {}),
              ...(rules.viaDiameterMm !== undefined ? { viaDiameterMm: rules.viaDiameterMm } : {}),
            },
          }
        : {}),
    },
  });
  await writeJson(manifestPath, manifest);
  importJson = report as unknown as Record<string, unknown>;
  importText = `Imported ${report.source.file} in ${report.timings.totalMs} ms: ${report.layers.copperCount} layers, ${report.counts.footprints} footprints, ${report.counts.pads} pads, ${report.counts.segments} segments, ${report.counts.vias} vias, ${report.counts.zones} zones, ${report.counts.nets} nets (${report.counts.netsRoutable} routable); dropped ${report.dropped.length}, unsupported ${report.unsupported.length}, failures ${report.failures.length}`;
  log(`import on disk in ${Math.round(performance.now() - t1)} ms`);
}
log(importText.split("\n")[0] ?? "");
if (importJson) {
  const r = importJson as {
    layers?: { copperCount?: number };
    dropped?: unknown[];
    unsupported?: unknown[];
    failures?: unknown[];
    counts?: Record<string, unknown>;
    timings?: Record<string, number>;
  };
  if (r.layers?.copperCount !== VAIO_B223.copperLayers)
    throw new Error(
      `expected ${VAIO_B223.copperLayers} copper layers, import reported ${r.layers?.copperCount}`,
    );
  log(
    `import report: ${r.layers?.copperCount} layers, timings ${JSON.stringify(r.timings)}, dropped ${JSON.stringify(r.dropped)}, unsupported ${JSON.stringify(r.unsupported)}, failures ${JSON.stringify(r.failures)}`,
  );
}

/* ---------- bench ---------- */
const benchOpts = {
  router,
  scenario,
  repeat,
  timeoutMs,
  repairRefs: [...VAIO_B223.repairRefs],
  copperPours: pours,
  label: `vaio-b223 ${VAIO_B223.commit.slice(0, 7)}`,
};
let report: Record<string, unknown> | null = null;
let viaDaemon =
  daemon !== null &&
  daemonTools.has("project_import_kicad") &&
  (router !== "freerouting" || daemon.channel === "internal");
if (daemon && !viaDaemon) {
  log(
    daemon.channel !== "internal" && router === "freerouting"
      ? `daemon channel is "${daemon.channel}": the freerouting adapter is absent there. Running the bench from source with FABDESK_CHANNEL=internal instead; restart the dev app with FABDESK_CHANNEL=internal to watch the frames in the Route Cinema.`
      : "the running daemon predates POST /bench/route; running the bench from source instead (restart the dev app to bench through it).",
  );
}
if (viaDaemon && daemon) {
  const started = await api<{ jobId: string }>(daemon, "/bench/route", {
    method: "POST",
    json: { project: projectId, ...benchOpts },
  });
  log(`bench job ${started.jobId} started via daemon (Route Cinema shows the frames)`);
  const job = await waitJob(daemon, started.jobId);
  if (job.status !== "done") throw new Error(`bench failed: ${job.error ?? job.status}`);
  report = job.result as Record<string, unknown>;
} else {
  const jsonOut = join(scratch, "bench.json");
  const args = [
    "run",
    join(repoRoot, "apps/core/src/main.ts"),
    "bench",
    "route",
    "--project",
    projectPath,
    "--router",
    router,
    "--scenario",
    scenario,
    "--repeat",
    String(repeat),
    "--timeout-ms",
    String(timeoutMs),
    "--pours",
    pours,
    "--refs",
    VAIO_B223.repairRefs.join(","),
    "--label",
    benchOpts.label,
    "--json",
    jsonOut,
  ];
  log(`$ FABDESK_CHANNEL=internal bun ${args.join(" ")}`);
  const proc = Bun.spawn(["bun", ...args], {
    cwd: repoRoot,
    env: { ...process.env, FABDESK_CHANNEL: "internal" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0 && code !== 1) throw new Error(`bench exited with ${code}: ${out.slice(0, 500)}`);
  report = JSON.parse(await readFile(jsonOut, "utf8")) as Record<string, unknown>;
}

const { formatBenchReport } = await import("../../packages/tools/src/bench");
log("");
log(formatBenchReport(report as never));
if (str("json"))
  await Bun.write(
    str("json")!,
    JSON.stringify(
      {
        fixture: VAIO_B223,
        board: { sha256: board.sha256, bytes: board.bytes },
        project: { id: projectId, dir: projectDir },
        import: importJson,
        bench: report,
      },
      null,
      2,
    ),
  );
log(`total ${Math.round((performance.now() - t0) / 1000)} s; project ${projectPath}`);
