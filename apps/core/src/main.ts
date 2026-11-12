#!/usr/bin/env bun
/** fabdesk-core CLI. stdout is reserved for machine output (ReadyLine, JSON, MCP stdio); logs go to stderr. */
import { chmod, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REMOTE_DEFAULT_PORT } from "@fabdesk/protocol";
import { VERSION, channel, fabdeskHome, resolveConfig } from "./config";
import { logger, errMsg, setLogLevel } from "./log";
import { initSentry } from "./sentry";
import { scrubAppImageRuntimeEnv } from "./appimage-env";

const FULL_USAGE = `fabdesk-core ${VERSION}

Usage:
  fabdesk-core serve [--port 0] [--host 127.0.0.1] [--handshake-file <path>] [--parent-pid <pid>] [--local-auth] [--data-dir <dir>]
                     [--remote] [--remote-host 0.0.0.0] [--remote-port ${REMOTE_DEFAULT_PORT}]   # turn on (and persist) remote access for phones
                     [--relay auto|off]                              # the fabplane.com relay for phones off the tailnet (default auto; FABPLANE_RELAY_URL overrides the host)
  fabdesk-core pair [--no-wait] [--invert] [--json]      # pairing QR + link for the running daemon; waits for the phone
  fabdesk-core devices list [--json]                     # paired phones on the running daemon
  fabdesk-core devices revoke <id|label>
  fabdesk-core mcp [--standalone] [--apps] [--project <dir>] [--tool-timeout <sec>]   # --tool-timeout: the host's per-call timeout, if raised
  fabpcb tool search <words> | describe <name> | call <name> [--request <json>] | batch --input @calls.jsonl
  fabpcb env describe [--project <dir>]
  fabpcb env exec [--project <dir>] -- <command> [arguments...]
  fabpcb revision status|checkpoint|accept|discard [--project <dir>] [--label <text>]
  fabpcb verify --project <dir>
  fabpcb render --project <dir> [--document schematic|pcb] [--request @render.json]
  fabpcb release --project <dir> --request @release.json
  fabpcb ipc search [--query <text>] [--operation <name>] [--document-type <type>] [--object-type <type>] [--capability <name>] [--headless <status>] [--limit 20]
  fabpcb ipc describe <operation> [--schema-depth 2]
  fabpcb ipc call <operation> [--request <json> | --request-file <path>] [--project <dir>] [--bridge-url <url>] [--timeout-ms 30000] [--expected-document-revision <n>]
  fabdesk-core login | logout | whoami
  fabdesk-core login --email <email> --password <password>   # staging/local only
  fabdesk-core doctor [--json]
                           [--timeout-ms 120000] [--refs U701,U702,...] [--frame-interval-ms N] [--pours polygon|omit] [--copper obstacles|omit]
                           [--label <tag>] [--json <out.json>]
  fabdesk-core install-cli
  fabdesk-core version

Environment:
  FABDESK_HOME           config/data dir (default: platform app-support dir)
  FABDESK_TOKEN          bearer token handed in by the parent (minted when absent)
  FABDESK_CHANNEL        public | internal (default public)
  FABDESK_AUTH_MODE      local | fabplane
  FABPLANE_API_ORIGIN    default https://api.fabplane.com
  FABPLANE_EMAIL         staging/local password login (also --email); not for production
  FABPLANE_PASSWORD      staging/local password login (also --password)
  FABDESK_PROJECTS_DIR   default ~/fabdesk
  FABDESK_CORE_URL       live local daemon used by the scriptable tool CLI
  FABDESK_LOG            debug | info | warn | error
  SENTRY_DESKTOP_DSN     Sentry DSN (error reporting off when unset; see docs/sentry.md)
  SENTRY_ENVIRONMENT     Sentry environment tag (default production for compiled builds, else development)
  SENTRY_RELEASE         Sentry release (default fabdesk-core@<version>+<git-sha>)
  FABDESK_SENTRY_TEST    1 sends one handled test event at startup and prints its id
  FABDESK_TAILSCALE_CLI  path to the tailscale binary for endpoint discovery, or "off"
`;

export function cliUsage(env: NodeJS.ProcessEnv = process.env): string {
  const mode = env["FABDESK_AGENT_INTERFACE"];
  if (mode !== "substrate" && mode !== "programmable") return FULL_USAGE;
  let usage = FULL_USAGE.replace(/^  fabdesk-core mcp.*\n/m, "").replace(/^  fabpcb tool.*\n/m, "");
  if (mode === "substrate") usage = usage.replace(/^  fabpcb ipc .*\n/gm, "");
  return usage;
}

function constrainedAgentInterface(): "substrate" | "programmable" | null {
  const mode = process.env["FABDESK_AGENT_INTERFACE"];
  return mode === "substrate" || mode === "programmable" ? mode : null;
}

type Flags = { _: string[]; [k: string]: string | boolean | string[] };

export function parseArgs(argv: string[]): Flags {
  const out: Flags = { _: [] };
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--" && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (!positionalOnly && a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
        continue;
      }
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

const str = (f: Flags, k: string): string | undefined =>
  typeof f[k] === "string" ? (f[k] as string) : undefined;
const num = (f: Flags, k: string): number | undefined =>
  str(f, k) !== undefined ? Number(str(f, k)) : undefined;
const flag = (f: Flags, k: string): boolean => f[k] === true || f[k] === "true" || f[k] === "1";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const f = parseArgs(argv);
  const cmd = f._[0] ?? "help";
  if (str(f, "log")) setLogLevel(str(f, "log") as never);
  switch (cmd) {
    case "version":
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(cliUsage());
      return 0;
    case "serve": {
      initSentry();
      // `--remote` edits the persisted setting before the daemon reads it; see cli/remote.ts.
      if (
        f["remote"] !== undefined ||
        f["remote-host"] !== undefined ||
        f["remote-port"] !== undefined ||
        f["relay"] !== undefined
      ) {
        const config = resolveConfig({
          ...(str(f, "data-dir") ? { dataDir: str(f, "data-dir")! } : {}),
        });
        const { persistRemoteFlags } = await import("./cli/remote");
        await mkdir(config.home, { recursive: true });
        try {
          const remote = await persistRemoteFlags(config.dbPath, f);
          if (remote)
            process.stderr.write(
              remote.enabled
                ? `Remote access on: phones connect to ${remote.host}:${remote.port}${remote.relay === "off" ? ", relay off" : ""} (persisted; pair one with: fabdesk-core pair)\n`
                : "Remote access off (persisted)\n",
            );
        } catch (e) {
          process.stderr.write(`serve: ${errMsg(e)}\n`);
          return 2;
        }
      }
      const { serve } = await import("./serve");
      const daemon = await serve({
        ...(num(f, "port") !== undefined ? { port: num(f, "port")! } : {}),
        ...(str(f, "host") ? { host: str(f, "host")! } : {}),
        ...(str(f, "handshake-file") ? { handshakeFile: str(f, "handshake-file")! } : {}),
        ...(num(f, "parent-pid") !== undefined ? { parentPid: num(f, "parent-pid")! } : {}),
        ...(flag(f, "local-auth") ? { localAuth: true } : {}),
        ...(str(f, "data-dir") ? { dataDir: str(f, "data-dir")! } : {}),
      });
      const stop = (sig: string) => void daemon.close(`signal ${sig}`);
      process.on("SIGINT", () => stop("SIGINT"));
      process.on("SIGTERM", () => stop("SIGTERM"));
      process.on("SIGHUP", () => stop("SIGHUP"));
      await daemon.closed;
      return 0;
    }
    case "mcp": {
      if (constrainedAgentInterface()) {
        process.stderr.write("fabdesk-core mcp is not exposed in this agent interface\n");
        return 2;
      }
      initSentry();
      const { runMcpStdio } = await import("./mcp-stdio");
      await runMcpStdio({
        ...(flag(f, "standalone") ? { standalone: true } : {}),
        ...(flag(f, "apps") ? { apps: true } : {}),
        ...(str(f, "project") ? { project: str(f, "project")! } : {}),
        ...(str(f, "data-dir") ? { dataDir: str(f, "data-dir")! } : {}),
        ...((num(f, "tool-timeout") ?? 0) > 0 ? { toolTimeoutSec: num(f, "tool-timeout")! } : {}),
      });
      return 0;
    }
    case "tool": {
      if (constrainedAgentInterface()) {
        process.stderr.write("fabpcb tool is not exposed in this agent interface\n");
        return 2;
      }
      const { runToolCli } = await import("./tool-cli");
      const action = f._[1] as "search" | "describe" | "call" | "batch" | undefined;
      const positional = f._.slice(2);
      return runToolCli({
        ...(action ? { action } : {}),
        ...(action === "search" ? { query: str(f, "query") ?? positional.join(" ") } : {}),
        ...((action === "describe" || action === "call") && positional[0]
          ? { name: positional[0] }
          : {}),
        ...(str(f, "request") ? { request: str(f, "request")! } : {}),
        ...(str(f, "input") ? { input: str(f, "input")! } : {}),
        ...(str(f, "project") ? { project: str(f, "project")! } : {}),
        ...(str(f, "url") ? { baseUrl: str(f, "url")! } : {}),
        ...(num(f, "limit") !== undefined ? { limit: num(f, "limit")! } : {}),
      });
    }
    case "env": {
      const { runHermeticEnv } = await import("./hermetic-env");
      const action = f._[1] as "describe" | "exec" | undefined;
      return runHermeticEnv({
        ...(action ? { action } : {}),
        ...(str(f, "project") ? { project: str(f, "project")! } : {}),
        ...(action === "exec" ? { command: f._.slice(2) } : {}),
      });
    }
    case "revision": {
      const { runProjectRevision } = await import("./project-revisions");
      const action = f._[1] as "status" | "checkpoint" | "accept" | "discard" | undefined;
      return runProjectRevision({
        ...(action ? { action } : {}),
        ...(str(f, "project") ? { project: str(f, "project")! } : {}),
        ...(str(f, "label") ? { label: str(f, "label")! } : {}),
      });
    }
    case "verify":
    case "render":
    case "release": {
      const { runArtifactCli } = await import("./artifact-cli");
      const document = str(f, "document");
      if (document && document !== "schematic" && document !== "pcb") {
        process.stderr.write("--document must be schematic or pcb\n");
        return 2;
      }
      const renderDocument = document as "schematic" | "pcb" | undefined;
      return runArtifactCli({
        action: cmd,
        ...(str(f, "project") ? { project: str(f, "project")! } : {}),
        ...(str(f, "request") ? { request: str(f, "request")! } : {}),
        ...(renderDocument ? { document: renderDocument } : {}),
        ...(str(f, "url") ? { baseUrl: str(f, "url")! } : {}),
      });
    }
    case "ipc": {
      if (constrainedAgentInterface() === "substrate") {
        process.stderr.write("fabpcb ipc is not exposed in the substrate interface\n");
        return 2;
      }
      const action = f._[1];
      const { directIpcCall, directIpcDescribe, directIpcSearch } = await import("./ipc-cli");
      let result: Record<string, unknown>;
      if (action === "search") {
        const headless = str(f, "headless");
        if (headless && !["ok", "gui-only", "partial", "unregistered", "any"].includes(headless)) {
          process.stderr.write(`ipc search: invalid --headless ${headless}\n`);
          return 2;
        }
        result = directIpcSearch({
          ...(str(f, "query") ? { query: str(f, "query")! } : {}),
          ...(str(f, "operation") ? { operation: str(f, "operation")! } : {}),
          ...(str(f, "document-type") ? { documentType: str(f, "document-type")! } : {}),
          ...(str(f, "object-type") ? { objectType: str(f, "object-type")! } : {}),
          ...(str(f, "capability") ? { capability: str(f, "capability")! } : {}),
          ...(headless
            ? { headless: headless as "ok" | "gui-only" | "partial" | "unregistered" | "any" }
            : {}),
          ...(num(f, "limit") !== undefined ? { limit: num(f, "limit")! } : {}),
        });
      } else if (action === "describe") {
        const operation = f._[2];
        if (!operation) {
          process.stderr.write("ipc describe: operation is required\n");
          return 2;
        }
        result = directIpcDescribe(operation, num(f, "schema-depth") ?? 2);
      } else if (action === "call") {
        const operation = f._[2];
        if (!operation) {
          process.stderr.write("ipc call: operation is required\n");
          return 2;
        }
        const inline = str(f, "request");
        const requestFile = str(f, "request-file");
        if (inline && requestFile) {
          process.stderr.write("ipc call: use only one of --request or --request-file\n");
          return 2;
        }
        let request: unknown = {};
        try {
          request = JSON.parse(requestFile ? await Bun.file(requestFile).text() : (inline ?? "{}"));
        } catch (error) {
          process.stderr.write(`ipc call: request is not valid JSON: ${errMsg(error)}\n`);
          return 2;
        }
        if (!request || typeof request !== "object" || Array.isArray(request)) {
          process.stderr.write("ipc call: request must be a JSON object\n");
          return 2;
        }
        result = await directIpcCall({
          operation,
          request: request as never,
          ...(str(f, "project") ? { projectDir: str(f, "project")! } : {}),
          ...(str(f, "bridge-url") ? { bridgeUrl: str(f, "bridge-url")! } : {}),
          ...(num(f, "timeout-ms") !== undefined ? { timeoutMs: num(f, "timeout-ms")! } : {}),
          ...(num(f, "expected-document-revision") !== undefined
            ? { expectedDocumentRevision: num(f, "expected-document-revision")! }
            : {}),
        });
      } else {
        process.stderr.write("ipc: expected search, describe, or call\n");
        return 2;
      }
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return result["ok"] === false ? 1 : 0;
    }
    case "login":
    case "logout":
    case "whoami": {
      const config = resolveConfig();
      const email = str(f, "email") ?? process.env["FABPLANE_EMAIL"];
      const password = str(f, "password") ?? process.env["FABPLANE_PASSWORD"];
      const credentials = email && password ? { email, password } : undefined;
      if (cmd === "login" && email && !password) {
        process.stderr.write(
          "login: --password or FABPLANE_PASSWORD is required when --email / FABPLANE_EMAIL is set\n",
        );
        return 2;
      }
      const { createAuth } = await import("./auth-facade");
      const auth = await createAuth({
        mode: config.authMode,
        channel: config.channel,
        home: config.home,
        apiOrigin: config.apiOrigin,
        emit: (e) => {
          if (e.topic === "auth.state" && e.state.pending && !credentials) {
            process.stderr.write(
              `Open ${e.state.pending.verificationUriComplete} and enter code ${e.state.pending.userCode}\n`,
            );
          }
        },
      });
      if (cmd === "login") {
        const st = await auth.login(undefined, credentials);
        if (st.pending && !credentials)
          process.stderr.write(
            `Open ${st.pending.verificationUriComplete} and enter code ${st.pending.userCode}\n`,
          );
        process.stdout.write(JSON.stringify(auth.state(), null, 2) + "\n");
        return auth.state().status === "signed_in" ? 0 : 1;
      }
      if (cmd === "logout") {
        process.stdout.write(JSON.stringify(await auth.logout(), null, 2) + "\n");
        return 0;
      }
      const st = auth.state();
      process.stdout.write(
        JSON.stringify(
          { mode: auth.mode, status: st.status, principal: st.principal ?? null },
          null,
          2,
        ) + "\n",
      );
      return st.status === "signed_in" ? 0 : 1;
    }
    case "devices":
    case "pair": {
      const config = resolveConfig({
        ...(str(f, "data-dir") ? { dataDir: str(f, "data-dir")! } : {}),
      });
      const { connectToDaemon, stdio } = await import("./cli/daemon");
      const client = await connectToDaemon(config, stdio);
      if (!client) return 1;
      try {
        if (cmd === "pair") {
          const { pairCommand, parsePairArgs } = await import("./cli/pair");
          return await pairCommand(client, parsePairArgs(f), stdio);
        }
        const { devicesCommand, parseDevicesArgs } = await import("./cli/devices");
        return await devicesCommand(client, parseDevicesArgs(f._, f), stdio);
      } catch (e) {
        process.stderr.write(`${cmd}: ${errMsg(e)}\n`);
        return 1;
      }
    }
    case "doctor": {
      const config = resolveConfig();
      const { Store } = await import("./db");
      const { runDoctor, formatDoctor } = await import("./doctor");
      await mkdir(config.home, { recursive: true });
      const store = Store.open(config.dbPath);
      const report = await runDoctor({ config, settings: store.settings.get() });
      store.close();
      process.stdout.write(
        flag(f, "json") ? JSON.stringify(report, null, 2) + "\n" : formatDoctor(report) + "\n",
      );
      return 0;
    }
    case "install-cli": {
      const target = process.execPath;
      if (process.platform === "win32") {
        process.stdout.write(`Add to PATH: ${join(target, "..")}\n`);
        return 0;
      }
      const bin = join(homedir(), ".local", "bin");
      await mkdir(bin, { recursive: true });
      const link = join(bin, "fabdesk");
      const pcbLink = join(bin, "fabpcb");
      await unlink(link).catch(() => {});
      await unlink(pcbLink).catch(() => {});
      await symlink(target, link);
      await symlink(target, pcbLink);
      await chmod(target, 0o755).catch(() => {});
      process.stdout.write(
        `Linked ${link} and ${pcbLink} → ${target}\nMake sure ${bin} is on your PATH. Then: claude mcp add --transport stdio fabdesk -- fabdesk mcp\n`,
      );
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n${cliUsage()}`);
      return 2;
  }
}

if (import.meta.main) {
  // Core is never an AppImage. Drop launcher identity before any kicad-cli spawn.
  scrubAppImageRuntimeEnv(process.env);
  main().then(
    (code) => process.exit(code),
    (e) => {
      logger.error("fatal", { error: errMsg(e) });
      process.stderr.write(`${errMsg(e)}\n`);
      process.exit(1);
    },
  );
}

export { fabdeskHome };
