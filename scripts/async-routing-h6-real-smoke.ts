/** Bounded H6 real-router smoke. Requires an isolated core/bridge; never discovers live daemons. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const baseUrl = process.env["H6_CORE_URL"];
const handshake = process.env["H6_HANDSHAKE"];
const kicadCli = process.env["KICAD_CLI"];
if (!baseUrl || !handshake || !kicadCli)
  throw new Error("H6_CORE_URL, H6_HANDSHAKE and KICAD_CLI are required");
const token = (JSON.parse(await readFile(handshake, "utf8")) as { token: string }).token;
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${raw}`);
  return {
    response,
    raw,
    json: JSON.parse(raw) as Record<string, any>,
    bytes: Buffer.byteLength(raw),
  };
}

const created = await request("/projects", {
  method: "POST",
  body: JSON.stringify({ name: `H6 Synthetic Real Router Smoke ${Date.now()}` }),
});
const project = created.json as { id: string; path: string };
const netlist = {
  netlist: {
    components: [
      {
        ref: "R1",
        value: "1k",
        footprint: "Resistor_SMD:R_0805_2012Metric",
        libSource: { lib: "Device", part: "R", description: "Resistor" },
      },
      {
        ref: "R2",
        value: "1k",
        footprint: "Resistor_SMD:R_0805_2012Metric",
        libSource: { lib: "Device", part: "R", description: "Resistor" },
      },
    ],
    nets: [
      {
        name: "SIGNAL",
        nodes: [
          { ref: "R1", pin: "1" },
          { ref: "R2", pin: "1" },
        ],
      },
      {
        name: "RETURN",
        nodes: [
          { ref: "R1", pin: "2" },
          { ref: "R2", pin: "2" },
        ],
      },
    ],
  },
  board: {
    widthMm: 30,
    heightMm: 20,
    copperLayers: 2,
    rules: { clearanceMm: 0.2, trackWidthMm: 0.25, viaDiameterMm: 0.8, viaDrillMm: 0.4 },
    placements: [
      { ref: "R1", position: { x: 7, y: 10 } },
      { ref: "R2", position: { x: 23, y: 10 } },
    ],
  },
};
await request(`/projects/${project.id}/files/circuit.netlist.json`, {
  method: "PUT",
  body: JSON.stringify(netlist),
});
const build = await request("/tools/circuit_build?sync=1", {
  method: "POST",
  body: JSON.stringify({ project: project.id }),
});
if (build.json.isError) throw new Error(`synthetic build failed: ${build.raw}`);
const boardPath = join(project.path, "board.kicad_pcb");
const beforeBytes = new Uint8Array(await Bun.file(boardPath).arrayBuffer());
const before = sha(beforeBytes);
const startedAt = new Date().toISOString();
const startClock = performance.now();
const start = await request("/tools/route_run?sync=1", {
  method: "POST",
  body: JSON.stringify({ project: project.id, timeoutMs: 30_000, applyPolicy: "manual" }),
});
const startMs = performance.now() - startClock;
const runId = start.json.json.runId as string;
let status = await request("/tools/route_status?sync=1", {
  method: "POST",
  body: JSON.stringify({ project: project.id, runId }),
});
const firstStatus = {
  bytes: status.bytes,
  state: status.json.json.run.state,
  at: new Date().toISOString(),
};
for (let attempt = 0; attempt < 600; attempt++) {
  const state = status.json.json.run.state as string;
  if (["completed", "failed", "cancelled", "timed_out", "interrupted"].includes(state)) break;
  await Bun.sleep(50);
  status = await request("/tools/route_status?sync=1", {
    method: "POST",
    body: JSON.stringify({ project: project.id, runId }),
  });
}
const run = status.json.json.run as Record<string, any>;
if (run.state !== "completed" || !run.candidate?.available || !run.candidate?.reopenable)
  throw new Error(`real route did not yield a validated candidate: ${status.raw}`);
const unchangedBeforeApply = sha(new Uint8Array(await Bun.file(boardPath).arrayBuffer()));
if (unchangedBeforeApply !== before)
  throw new Error("manual real route changed canonical board before apply");
const applyClock = performance.now();
const apply = await request("/tools/route_apply?sync=1", {
  method: "POST",
  body: JSON.stringify({ project: project.id, runId, expectedPcbRevision: before }),
});
const applyMs = performance.now() - applyClock;
const after = sha(new Uint8Array(await Bun.file(boardPath).arrayBuffer()));
if (after !== apply.json.json.resultingPcbRevision)
  throw new Error("applied real board revision mismatch");
const versionProc = Bun.spawn([kicadCli, "--version"], {
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});
const version = (await new Response(versionProc.stdout).text()).trim();
await versionProc.exited;

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      project: { id: project.id, path: project.path, synthetic: true, pcbgolf: false },
      runtimeId: run.runtimeId,
      kicad: { path: kicadCli, version },
      router: run.router,
      runId,
      timingsMs: { start: startMs, route: run.progress.elapsedMs, apply: applyMs },
      responseBytes: {
        start: start.bytes,
        firstStatus: firstStatus.bytes,
        finalStatus: status.bytes,
        apply: apply.bytes,
      },
      states: {
        start: start.json.json.state,
        firstStatus: firstStatus.state,
        final: run.state,
        application: apply.json.json.state,
      },
      revisions: {
        starting: before,
        unchangedBeforeApply,
        candidate: run.candidate.sha256,
        resulting: after,
      },
      candidate: {
        identity: run.candidate.identity,
        bytes: run.candidate.bytes,
        reopenable: run.candidate.reopenable,
        diff: run.candidate.diff,
      },
      artifacts: run.artifacts,
    },
    null,
    2,
  )}\n`,
);
