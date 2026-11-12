import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentRun, AgentSession } from "@fabdesk/agents";
import type { FinishItSession } from "@fabdesk/protocol";
import { recordReviewGate, writeDoneMode, type CoreServices } from "@fabdesk/tools";
import { serve, type Daemon } from "../src/serve";
import { mockServices } from "../../../packages/tools/test/mock-services";

const NETLIST = {
  netlist: {
    components: [{ ref: "R1", value: "1k", footprint: "Resistor_SMD:R_0402_1005Metric" }],
    nets: [{ name: "N1", nodes: [{ ref: "R1", pin: "1" }] }],
  },
};


let lastPrompt: string | null = null;
const runsByProject = new Map<string, number>();
const runsIn = (dir: string) => runsByProject.get(dir) ?? 0;
let daemon: Daemon;
let home: string;

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "fabdesk-finish-it-board-"));
  process.env["FABDESK_PROJECTS_DIR"] = join(home, "Fabdesk");
  process.env["FABDESK_TOKEN"] = "test-token-finish-it-board-012345";
  process.env["FABDESK_CHANNEL"] = "internal";
  daemon = await serve({
    port: 0,
    dataDir: home,
    handshakeFile: join(home, "daemon.json"),
    localAuth: true,
    parentPid: process.pid,
    quiet: true,
    watchProjects: false,
    abortSettleTimeoutMs: 200,
    // the board workflow's check tool is registered on this host
    boardChecks: () => true,
    services: async ({ projects, bus, store }) =>
      mockServices([], { projects, bus: { emit: (e) => bus.emit(e) }, routeRuns: store.routeRuns, channel: "internal" }) as unknown as CoreServices,
    adapters: {
      claude: {
        id: "claude",
        run: (session: AgentSession): AgentRun => {
          runsByProject.set(session.cwd, runsIn(session.cwd) + 1);
          lastPrompt = session.prompt;
          return {
            events: (async function* (): AsyncGenerator<AgentEvent> {
              yield { type: "init", sessionId: "fin-t", mcpServers: [] };
              yield { type: "text", delta: "ok" };
              yield { type: "done", exitCode: 0, sessionId: "fin-t" };
            })(),
            abort() {},
          };
        },
      },
    },
    doctor: async () => ({ version: "t", channel: "internal", bun: Bun.version, platform: "test", kicad: { found: false }, ngspice: { found: false }, routers: [], agents: [], warnings: [] }),
  });
});

afterAll(async () => {
  await daemon.close("tests done");
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${daemon.url}${path}`, { ...init, headers: { authorization: `Bearer ${daemon.token}`, "content-type": "application/json", ...(init.headers ?? {}) } });

async function createProject(name: string): Promise<{ id: string; path: string }> {
  return (await (await api("/projects", { method: "POST", body: JSON.stringify({ name }) })).json()) as { id: string; path: string };
}

/** A project whose DRC/route reports are clean for the PCB below, i.e. finished by the old definition. */
async function cleanProject(name: string, pcb: string): Promise<{ id: string; path: string }> {
  const project = await createProject(name);
  await writeFile(join(project.path, "circuit.netlist.json"), JSON.stringify(NETLIST));
  await writeFile(join(project.path, "board.kicad_pcb"), pcb);
  await mkdir(join(project.path, "reports"), { recursive: true });
  const sha = createHash("sha256").update(pcb).digest("hex");
  await writeFile(join(project.path, "reports/drc.json"), JSON.stringify({ counts: { errors: 0, warnings: 0, unconnected: 0 }, pcbRevision: { sha256: sha }, schematicParityChecked: true }));
  await writeFile(join(project.path, "reports/route.json"), JSON.stringify({ ok: true, open: 0 }));
  const future = new Date(Date.now() + 60_000);
  for (const f of ["reports/drc.json", "reports/route.json"]) await utimes(join(project.path, f), future, future);
  return project;
}

const accept = (path: string, pcb: string, summary: Record<string, boolean>) =>
  mkdir(join(path, ".fabdesk/board/accept"), { recursive: true }).then(() =>
    writeFile(join(path, ".fabdesk/board/accept/index.json"), JSON.stringify([{ at: "t", sha256: createHash("sha256").update(pcb).digest("hex"), summary }])));

async function finish(id: string) {
  const res = await api(`/projects/${id}/finish-it`, { method: "POST", body: JSON.stringify({ agentId: "claude" }) });
  expect(res.status).toBe(202);
  return ((await res.json()) as { session: FinishItSession }).session;
}

describe("Finish it with the board workflow on", () => {
  test("clean DRC/route reports are not finished until A1-A9 and the review gate say so; the agent is told the board stages", async () => {
    lastPrompt = null;
    const pcb = "(kicad_pcb (footprint \"R\") board-open)\n";
    const project = await cleanProject("Needs Acceptance", pcb);
    const session = await finish(project.id);
    const ids = session.milestones.map((m) => m.id);
    expect(ids).toEqual(["schematic", "build", "route", "verify", "review"]);
    const pending = session.milestones.filter((m) => m.status === "pending" || m.status === "running").map((m) => m.id);
    expect(pending).toContain("verify");
    expect(pending).toContain("review");
    // first snapshot of a placed, never measured board: judged by no new failure
    expect(JSON.parse(await Bun.file(join(project.path, ".fabdesk/board/done-mode.json")).text()).mode).toBe("no-regression");
    for (let i = 0; i < 100 && runsIn(project.path) === 0; i++) await Bun.sleep(25);
    expect(runsIn(project.path)).toBeGreaterThan(0);
    expect(lastPrompt).toContain("board_check");
    expect(lastPrompt).toContain("5. review");
    // let the run and its follow-ups end before the daemon is closed
    for (let i = 0; i < 400; i++) {
      const body = (await (await api(`/projects/${project.id}/finish-it`)).json()) as { session: FinishItSession | null };
      if (body.session && body.session.status !== "running" && body.session.status !== "stopping") break;
      await Bun.sleep(25);
    }
  });

  test("passing A1-A9 plus a passing review gate on the saved board complete it without an agent", async () => {
    const pcb = "(kicad_pcb (footprint \"R\") board-done)\n";
    const project = await cleanProject("Accepted Board", pcb);
    await accept(project.path, pcb, { A1_connectivity: true, A2_drc: true });
    await recordReviewGate(project.path, { current: true, open: 0, mustFix: 0 });
    const session = await finish(project.id);
    expect(session.status).toBe("completed");
    expect(session.milestones.every((m) => m.status === "skipped" || m.status === "done")).toBe(true);
    await Bun.sleep(200);
    expect(runsIn(project.path)).toBe(0);
  });

  test("a board that came in with opens and DRC findings completes on no new failure, without an agent", async () => {
    const pcb = "(kicad_pcb (footprint \"R\") board-inherited-failures)\n";
    const project = await cleanProject("Inherited Failures", pcb);
    // DRC says 3 errors and 9 unconnected: the board's own state from before the work
    await writeFile(join(project.path, "reports/drc.json"), JSON.stringify({ counts: { errors: 3, warnings: 0, unconnected: 9 }, pcbRevision: { sha256: createHash("sha256").update(pcb).digest("hex") }, schematicParityChecked: true }));
    await mkdir(join(project.path, ".fabdesk/board/accept"), { recursive: true });
    const sha = createHash("sha256").update(pcb).digest("hex");
    const failing = { A1_connectivity: false, A2_drc: false, A3_parity: false, A5_anchors: true };
    await writeFile(join(project.path, ".fabdesk/board/accept/index.json"), JSON.stringify([{ at: "t0", sha256: "first-board", summary: failing }, { at: "t1", sha256: sha, summary: failing }]));
    await writeDoneMode(project.path, "no-regression");
    await recordReviewGate(project.path, { current: true, open: 0, mustFix: 0 });
    const session = await finish(project.id);
    expect(session.status).toBe("completed");
    expect(runsIn(project.path)).toBe(0);
  });

  test("a review gate recorded for an earlier board does not count", async () => {
    const pcb = "(kicad_pcb (footprint \"R\") board-stale-review)\n";
    const project = await cleanProject("Stale Review", pcb);
    await accept(project.path, pcb, { A1_connectivity: true, A2_drc: true });
    await recordReviewGate(project.path, { current: true, open: 0, mustFix: 0 });
    await writeFile(join(project.path, "board.kicad_pcb"), `${pcb};; edited after the review\n`);
    const session = await finish(project.id);
    expect(session.status).not.toBe("completed");
    for (let i = 0; i < 400; i++) {
      const body = (await (await api(`/projects/${project.id}/finish-it`)).json()) as { session: FinishItSession | null };
      if (body.session && body.session.status !== "running" && body.session.status !== "stopping") break;
      await Bun.sleep(25);
    }
  });
});
