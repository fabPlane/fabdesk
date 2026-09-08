#!/usr/bin/env bun
/** fabdesk-core CLI. stdout is reserved for machine output (ReadyLine, JSON, MCP stdio); logs go to stderr. */
import { chmod, mkdir, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { VERSION, channel, fabdeskHome, resolveConfig } from "./config";
import { logger, errMsg, setLogLevel } from "./log";
import { initSentry } from "./sentry";

const USAGE = `fabdesk-core ${VERSION}

Usage:
  fabdesk-core serve [--port 0] [--host 127.0.0.1] [--handshake-file <path>] [--parent-pid <pid>] [--local-auth] [--data-dir <dir>]
  fabdesk-core mcp [--standalone] [--project <dir>]
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
  FABDESK_LOG            debug | info | warn | error
  SENTRY_DESKTOP_DSN     Sentry DSN (error reporting off when unset; see docs/sentry.md)
  SENTRY_ENVIRONMENT     Sentry environment tag (default production for compiled builds, else development)
  SENTRY_RELEASE         Sentry release (default fabdesk-core@<version>+<git-sha>)
  FABDESK_SENTRY_TEST    1 sends one handled test event at startup and prints its id
`;

type Flags = { _: string[]; [k: string]: string | boolean | string[] };

export function parseArgs(argv: string[]): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
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

const str = (f: Flags, k: string): string | undefined => (typeof f[k] === "string" ? (f[k] as string) : undefined);
const num = (f: Flags, k: string): number | undefined => (str(f, k) !== undefined ? Number(str(f, k)) : undefined);
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
      process.stdout.write(USAGE);
      return 0;
    case "serve": {
      initSentry();
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
      initSentry();
      const { runMcpStdio } = await import("./mcp-stdio");
      await runMcpStdio({ ...(flag(f, "standalone") ? { standalone: true } : {}), ...(str(f, "project") ? { project: str(f, "project")! } : {}), ...(str(f, "data-dir") ? { dataDir: str(f, "data-dir")! } : {}) });
      return 0;
    }
    case "login":
    case "logout":
    case "whoami": {
      const config = resolveConfig();
      const email = str(f, "email") ?? process.env["FABPLANE_EMAIL"];
      const password = str(f, "password") ?? process.env["FABPLANE_PASSWORD"];
      const credentials = email && password ? { email, password } : undefined;
      if (cmd === "login" && email && !password) {
        process.stderr.write("login: --password or FABPLANE_PASSWORD is required when --email / FABPLANE_EMAIL is set\n");
        return 2;
      }
      const { createAuth } = await import("./auth-facade");
      const auth = await createAuth({ mode: config.authMode, channel: config.channel, home: config.home, apiOrigin: config.apiOrigin, emit: (e) => {
        if (e.topic === "auth.state" && e.state.pending && !credentials) {
          process.stderr.write(`Open ${e.state.pending.verificationUriComplete} and enter code ${e.state.pending.userCode}\n`);
        }
      } });
      if (cmd === "login") {
        const st = await auth.login(undefined, credentials);
        if (st.pending && !credentials) process.stderr.write(`Open ${st.pending.verificationUriComplete} and enter code ${st.pending.userCode}\n`);
        process.stdout.write(JSON.stringify(auth.state(), null, 2) + "\n");
        return auth.state().status === "signed_in" ? 0 : 1;
      }
      if (cmd === "logout") {
        process.stdout.write(JSON.stringify(await auth.logout(), null, 2) + "\n");
        return 0;
      }
      const st = auth.state();
      process.stdout.write(JSON.stringify({ mode: auth.mode, status: st.status, principal: st.principal ?? null }, null, 2) + "\n");
      return st.status === "signed_in" ? 0 : 1;
    }
    case "doctor": {
      const config = resolveConfig();
      const { Store } = await import("./db");
      const { runDoctor, formatDoctor } = await import("./doctor");
      await mkdir(config.home, { recursive: true });
      const store = Store.open(config.dbPath);
      const report = await runDoctor({ config, settings: store.settings.get() });
      store.close();
      process.stdout.write(flag(f, "json") ? JSON.stringify(report, null, 2) + "\n" : formatDoctor(report) + "\n");
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
      await unlink(link).catch(() => {});
      await symlink(target, link);
      await chmod(target, 0o755).catch(() => {});
      process.stdout.write(`Linked ${link} → ${target}\nMake sure ${bin} is on your PATH. Then: claude mcp add --transport stdio fabdesk -- fabdesk mcp\n`);
      return 0;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
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
