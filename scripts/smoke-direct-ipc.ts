#!/usr/bin/env bun
/** Packaged Option 3 smoke: extracted AppImage core CLI -> nng IPC -> bundled KiCad. */
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const value = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const appImage = value("--appimage");
const output = value("--output");
if (!appImage) throw new Error("usage: bun scripts/smoke-direct-ipc.ts --appimage <file> [--output <json>]");

const artifact = resolve(appImage);
const scratch = await mkdtemp(join(tmpdir(), "fabdesk-direct-ipc-smoke-"));
const extraction = join(scratch, "squashfs-root");
const project = join(scratch, "project");
let bridge: ReturnType<typeof Bun.spawn> | undefined;

function env(overrides: Record<string, string>): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...overrides };
}

async function waitForBridge(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  if (!proc.stdout || typeof proc.stdout === "number") throw new Error("bridge stdout is unavailable");
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("bridge startup timed out")), Math.max(1, deadline - Date.now()))),
    ]);
    if (next.done) throw new Error(`bridge exited before readiness: ${text}`);
    text += decoder.decode(next.value, { stream: true });
    const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(text);
    if (match) return match[1]!;
  }
  throw new Error(`bridge startup timed out: ${text}`);
}

async function coreJson(core: string, cliArgs: string[], environment: Record<string, string>, expectedCode = 0): Promise<Record<string, any>> {
  const proc = Bun.spawn([core, ...cliArgs], { cwd: project, env: environment, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== expectedCode) throw new Error(`core ${cliArgs.join(" ")} exited ${code}, expected ${expectedCode}: ${stderr}\n${stdout}`);
  try {
    return JSON.parse(stdout) as Record<string, any>;
  } catch {
    throw new Error(`core ${cliArgs.join(" ")} did not return JSON: ${stderr}\n${stdout}`);
  }
}

try {
  const extracted = Bun.spawnSync([artifact, "--appimage-extract"], { cwd: scratch, stdout: "ignore", stderr: "pipe" });
  if (!extracted.success) throw new Error(`AppImage extraction failed: ${extracted.stderr.toString()}`);
  const core = join(extraction, "resources/core/fabdesk-core");
  const pcb = join(extraction, "resources/pcb");
  const bridgeBin = join(pcb, "bin/fp-pcb-bridge");
  const kicadCli = join(pcb, "kicad/bin/kicad-cli");
  const kicadStockData = join(pcb, "kicad/share/kicad");
  const libraryPath = [join(pcb, "kicad/lib"), join(pcb, "kicad/lib/runtime"), process.env["LD_LIBRARY_PATH"]].filter(Boolean).join(":");
  for (const path of [core, bridgeBin, kicadCli]) await chmod(path, 0o755);
  await mkdir(project, { recursive: true });

  bridge = Bun.spawn([bridgeBin], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
    env: env({
      PORT: "0",
      HOST: "127.0.0.1",
      KICAD_CLI: kicadCli,
      KICAD_STOCK_DATA_HOME: kicadStockData,
      LD_LIBRARY_PATH: libraryPath,
      WORKSPACE_ROOT: scratch,
      KICAD_FOOTPRINT_DIR: join(pcb, "libraries/footprints"),
      KICAD_SYMBOL_DIR: join(pcb, "libraries/symbols"),
      FABDESK_RUNTIME_ID: "option-3-packaged-smoke",
      KICAD_EVENTS: "0",
    }),
  });
  const bridgeUrl = await waitForBridge(bridge);
  const coreEnv = env({
    FABDESK_FP_PCB_BRIDGE_URL: bridgeUrl,
    FABDESK_RUNTIME_ID: "option-3-packaged-smoke",
    KICAD_CLI: kicadCli,
    KICAD_STOCK_DATA_HOME: kicadStockData,
    LD_LIBRARY_PATH: libraryPath,
  });

  const search = await coreJson(core, ["ipc", "search", "--operation", "GetVersion", "--headless", "ok"], coreEnv);
  if (search.results?.[0]?.operation !== "GetVersion") throw new Error("ipc search did not find GetVersion");
  const description = await coreJson(core, ["ipc", "describe", "GetVersion", "--schema-depth", "1"], coreEnv);
  if (description.requestType !== "kiapi.common.commands.GetVersion") throw new Error("ipc describe returned the wrong request schema");
  const version = await coreJson(core, ["ipc", "call", "GetVersion", "--request", "{}", "--bridge-url", bridgeUrl], coreEnv);
  if (!version.ok || !version.response?.version?.fullVersion) throw new Error("ipc call GetVersion returned no version");
  if (version.transport?.kind !== "nng-ipc") throw new Error("ipc call did not use direct nng IPC");

  const newProject = await coreJson(
    core,
    ["ipc", "call", "NewProject", "--project", project, "--request", JSON.stringify({ path: join(project, "board.kicad_pro"), open: true }), "--bridge-url", bridgeUrl],
    coreEnv,
  );
  if (!newProject.ok) throw new Error("ipc call NewProject failed");
  const openBoard = await coreJson(
    core,
    ["ipc", "call", "OpenDocument", "--project", project, "--request", JSON.stringify({ type: "DOCTYPE_PCB", path: join(project, "board.kicad_pcb") }), "--bridge-url", bridgeUrl],
    coreEnv,
  );
  if (!openBoard.ok) throw new Error("ipc call OpenDocument failed");
  const stale = await coreJson(
    core,
    [
      "ipc", "call", "GetDocumentRevision", "--project", project,
      "--request", JSON.stringify({ document: { type: "DOCTYPE_PCB", boardFilename: "board.kicad_pcb" } }),
      "--expected-document-revision", "999999", "--bridge-url", bridgeUrl,
    ],
    coreEnv,
    1,
  );
  if (stale.failure?.code !== "stale_document") throw new Error(`stale revision did not fail closed: ${JSON.stringify(stale)}`);

  const report = {
    ok: true,
    testedAt: new Date().toISOString(),
    appImage: { path: artifact, sha256: createHash("sha256").update(await readFile(artifact)).digest("hex") },
    packaged: { core, bridge: bridgeBin, kicadCli, kicadVersion: version.response.version.fullVersion },
    runtime: version.runtime,
    transport: version.transport,
    session: version.session,
    catalog: version.catalog,
    schema: version.schema,
    discovery: { operation: search.results[0].operation, requestType: description.requestType, responseType: description.responseType },
    staleDocument: stale.failure,
    mcpUsed: false,
  };
  if (output) {
    const target = resolve(output);
    await mkdir(dirname(target), { recursive: true });
    await Bun.write(target, JSON.stringify(report, null, 2) + "\n");
  }
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  bridge?.kill("SIGTERM");
  if (bridge) await bridge.exited.catch(() => undefined);
  await rm(scratch, { recursive: true, force: true });
}
