// Model-free regression: packaged MCP -> core route_run -> packaged native bridge.
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const [packageRoot, label, source, outRoot, mode = "saved"] = process.argv.slice(2) as string[];
if (!packageRoot || !label || !source || !outRoot)
  throw Error("packageRoot label seed outputRoot [saved|unsaved]");
const out = join(outRoot, label);
if (await Bun.file(join(out, "results.json")).exists()) throw Error("record already exists");
await mkdir(out, { recursive: true });
const workspace = await mkdtemp(
  join((await import("node:os")).tmpdir(), "fabdesk-route-recovery-"),
);
const bundle = join(packageRoot, "resources/pcb"),
  manifest = await Bun.file(join(bundle, "bundle.json")).json();
const portServer = Bun.serve({ port: 0, fetch: () => new Response("") });
const port = portServer.port;
portServer.stop(true);
const env: any = {
  ...process.env,
  FABDESK_HOME: join(workspace, "core"),
  FABDESK_PROJECTS_DIR: join(workspace, "projects"),
  FABDESK_AUTH_MODE: "local",
  FABDESK_TAILSCALE_CLI: "off",
  FABDESK_AGENT_INTERFACE: "full",
  FABDESK_UPDATE_CHECK: "0",
  FABDESK_RESOURCES: join(packageRoot, "resources"),
  FABDESK_FP_PCB_BRIDGE_URL: `http://127.0.0.1:${port}`,
  KICAD_CLI: join(bundle, manifest.kicadCli),
  KICAD_STOCK_DATA_HOME: join(bundle, manifest.stockData),
  KICAD_FOOTPRINT_DIR: join(bundle, manifest.footprints),
  KICAD_SYMBOL_DIR: join(bundle, manifest.symbols),
  KICAD10_FOOTPRINT_DIR: join(bundle, manifest.footprints),
  KICAD10_SYMBOL_DIR: join(bundle, manifest.symbols),
  LD_LIBRARY_PATH: manifest.libraryPaths.map((p: string) => join(bundle, p)).join(":"),
  FREEROUTING_JAR: join(bundle, manifest.freerouting.jar),
  FP_PCB_JAVA: join(bundle, manifest.freerouting.java),
  FAB_ROUTER_MODULE: join(bundle, manifest.fabRouter),
  WORKSPACE_ROOT: workspace,
  HOST: "127.0.0.1",
  PORT: String(port),
};
await mkdir(env.FABDESK_HOME, { recursive: true });
await writeFile(join(env.FABDESK_HOME, ".fabdesk-dev"), "isolated diagnostic");
const bridge = Bun.spawn(["setsid", "xvfb-run", "-a", join(bundle, manifest.bridge)], {
  env,
  stdout: Bun.file(join(out, "bridge.log")),
  stderr: Bun.file(join(out, "bridge-errors.log")),
});
const hsPath = join(workspace, "daemon.json");
const core = Bun.spawn(
  [
    "setsid",
    join(packageRoot, "resources/core/fabdesk-core"),
    "serve",
    "--port",
    "0",
    "--host",
    "127.0.0.1",
    "--handshake-file",
    hsPath,
    "--local-auth",
    "--relay",
    "off",
  ],
  { env, stdout: Bun.file(join(out, "core.log")), stderr: Bun.file(join(out, "core-errors.log")) },
);
const record: any = {
  utcStart: new Date().toISOString(),
  packageRoot,
  label,
  source,
  workspace,
  cases: [],
};
let client: any;
try {
  let hs: any;
  for (let i = 0; i < 600; i++) {
    try {
      hs = await Bun.file(hsPath).json();
      if (hs.token) break;
    } catch {}
    if (core.exitCode !== null) throw Error("core exited");
    await Bun.sleep(100);
  }
  if (!hs?.token) throw Error("no handshake");
  for (let i = 0; i < 600; i++) {
    try {
      if ((await (await fetch(`${env.FABDESK_FP_PCB_BRIDGE_URL}/health`)).json()).ok) break;
    } catch {}
    await Bun.sleep(100);
  }
  client = new Client({ name: "route-recovery-regression", version: "1.0" }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://${hs.host}:${hs.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${hs.token}` } },
    }),
  );
  const api = async (path: string, body: any) => {
    const res = await fetch(`http://${hs.host}:${hs.port}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${hs.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw Error(await res.text());
    return res.json() as any;
  };
  record.source = source;
  record.hashes = {};
  for (const f of [
    "resources/core/fabdesk-core",
    "resources/app.asar",
    `resources/pcb/${manifest.bridge}`,
  ]) {
    const p = join(packageRoot, f);
    if (await Bun.file(p).exists())
      record.hashes[f] = new Bun.CryptoHasher("sha256")
        .update(await Bun.file(p).arrayBuffer())
        .digest("hex");
  }
  for (const router of ["freerouting", "fab_router"]) {
    const c: any = { router, calls: [], utcStart: new Date().toISOString() };
    record.cases.push(c);
    try {
      const project = await api("/projects", { name: `${label}-${router}` });
      c.project = project;
      await cp(source, project.path, { recursive: true });
      const tool = async (name: string, args: any = {}) => {
        const response: any = await client.callTool(
          { name, arguments: { project: project.id, ...args } },
          undefined,
          { timeout: 300000 },
        );
        c.calls.push({ name, args, response });
        return response;
      };
      await tool("schematic_edit", {
        texts: [{ text: "SAVED_ROUTE_REGRESSION", position: { x: 10, y: 10 } }],
        save: true,
      });
      if (
        !(await readFile(join(project.path, "board.kicad_sch"), "utf8")).includes(
          "SAVED_ROUTE_REGRESSION",
        )
      )
        throw Error("the saved schematic edit did not reach the native file");
      c.savedEditVerified = true;
      if (mode === "unsaved") {
        const retained = await api("/tools/project_checkpoint?sync=1", {
          project: project.id,
          action: "retain",
          name: "before unsaved",
          reason: "unsaved protection regression",
          role: "baseline",
        });
        c.retained = retained.json;
        await tool("schematic_edit", {
          texts: [{ text: "UNSAVED_ROUTE_REGRESSION", position: { x: 15, y: 15 } }],
          save: false,
        });
        c.beforeUnsaved = await readFile(join(project.path, "board.kicad_sch"), "utf8");
        const compare = await api("/tools/project_checkpoint?sync=1", {
          project: project.id,
          action: "compare",
        });
        const refusal = await fetch(
          `http://${hs.host}:${hs.port}/tools/project_checkpoint?sync=1`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${hs.token}`, "content-type": "application/json" },
            body: JSON.stringify({
              project: project.id,
              action: "restore",
              checkpointId: retained.json.id,
              expectedRevision: compare.json.currentRevision,
              reason: "must protect live work",
            }),
          },
        );
        c.unsavedRefusal = { status: refusal.status, body: await refusal.json() };
        if (refusal.ok || !JSON.stringify(c.unsavedRefusal).includes("unsaved or unknown"))
          throw Error("unsaved restore did not refuse");
      }

      const response = await tool("route_run", {
        router,
        waitMs: 60000,
        timeoutMs: 90000,
        applyPolicy: "auto",
        rules: { refillZones: false },
      });
      let data = response.structuredContent?.json ?? response.structuredContent;
      // MCP text includes the full structured tool response; retain and resolve durable run by disk.
      const runs = await Array.fromAsync(
        new Bun.Glob(".fabdesk/runs/*/request.json").scan({ cwd: project.path, dot: true }),
      );
      c.runFiles = runs;
      const runId = runs[0]?.split("/")[2];
      if (!runId) throw Error("missing route run");
      c.run = response.structuredContent?.run;
      for (
        let i = 0;
        !c.run || !["completed", "failed", "timed_out", "cancelled"].includes(c.run.state);
        i++
      ) {
        if (i >= 400) throw Error("outer timeout");
        const status = await api("/tools/route_status?sync=1", { project: project.id, runId });
        c.run = status.json?.run;
        await Bun.sleep(250);
      }
      await cp(join(project.path, ".fabdesk/runs"), join(out, router), { recursive: true });
      c.candidate =
        (
          await Array.fromAsync(
            new Bun.Glob("**/candidate.kicad_pcb").scan({ cwd: join(out, router), dot: true }),
          )
        ).length > 0;
      if (!c.candidate) throw Error(`no candidate: ${JSON.stringify(c.run ?? response)}`);
      if (mode === "unsaved") {
        if ((await readFile(join(project.path, "board.kicad_sch"), "utf8")) !== c.beforeUnsaved)
          throw Error("unsaved work unexpectedly saved");
        await tool("schematic_edit", { texts: [], save: true });
        if (
          !(await readFile(join(project.path, "board.kicad_sch"), "utf8")).includes(
            "UNSAVED_ROUTE_REGRESSION",
          )
        )
          throw Error("live unsaved work lost");
        if (c.run.application.state === "applied")
          throw Error("route application discarded unsaved work");
        if (!JSON.stringify(c.run.application).includes("unsaved or unknown"))
          throw Error("route application did not report live-work refusal");
        c.unsavedProtection = "pass";
        delete c.beforeUnsaved;
      }
      c.verdict = "pass";
    } catch (e) {
      c.error = String(e);
      c.verdict = "fail";
    }
    c.utcEnd = new Date().toISOString();
    console.log(JSON.stringify({ label, router, verdict: c.verdict, error: c.error }));
  }
  record.verdict = record.cases.every((c: any) => c.verdict === "pass") ? "pass" : "fail";
} catch (e) {
  record.error = String(e);
  record.verdict = "invalid";
} finally {
  record.utcEnd = new Date().toISOString();
  await writeFile(join(out, "results.json"), JSON.stringify(record, null, 2));
  await client?.close().catch(() => {});
  for (const proc of [core, bridge]) {
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      proc.kill();
    }
  }
  await Promise.all([core.exited, bridge.exited]);
}
if (record.verdict !== "pass") process.exitCode = 1;
