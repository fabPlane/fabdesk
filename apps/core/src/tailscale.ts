/**
 * What the Tailscale CLI knows that interface classification cannot: the node's MagicDNS name,
 * whether the tailnet issues HTTPS certificates, and whether `tailscale serve` already fronts
 * the remote listener on 443. `listenAddresses` (net.ts) composes this into the endpoint list;
 * without the CLI it falls back to the CGNAT-range guess exactly as before.
 *
 * Everything here shells out to `tailscale`, which is slow enough (tens of ms, more when the
 * daemon is wedged) that results are cached briefly — Settings polls `/v1/remote`. The CLI is
 * only ever invoked with `status` / `serve status` (read-only) and, on an explicit user action,
 * `serve --bg` / `serve reset`.
 */
import { existsSync } from "node:fs";
import { isWildcardHost } from "./net";
import { errMsg, logger } from "./log";

export interface TailscaleServe {
  /** The HTTPS port `tailscale serve` listens on (443 unless someone configured it by hand). */
  port: number;
  /** The proxy target, as configured: `http://127.0.0.1:47820`. */
  target: string;
}

export interface TailscaleInfo {
  cli: string;
  /** `Running`, `Stopped`, `NeedsLogin` … (`BackendState`). */
  backendState: string;
  /** Tailnet IPv4 (`Self.TailscaleIPs`), null when the node is down or logged out. */
  ip: string | null;
  /** `Self.DNSName` without its trailing dot, null when MagicDNS is off. */
  dnsName: string | null;
  /** The tailnet's HTTPS certificates feature is on (`CertDomains` lists this node). */
  httpsEnabled: boolean;
  /** Every `serve` HTTPS proxy currently configured, whatever it targets. */
  serves: TailscaleServe[];
}

export interface TailscaleProvider {
  /** Null when no CLI is installed. `fresh` bypasses the cache (after a `serve` change). */
  info(opts?: { fresh?: boolean }): Promise<TailscaleInfo | null>;
  /** `tailscale serve --bg https:443 <target>` or `serve reset`. Throws with the CLI's stderr. */
  setServe(enabled: boolean, target: { host: string; port: number }): Promise<void>;
}

/** Override for tests and unusual installs; `off` disables the CLI entirely. */
export const TAILSCALE_CLI_ENV = "FABDESK_TAILSCALE_CLI";
const TIMEOUT_MS = 2000;
const CACHE_MS = 10_000;

const KNOWN_LOCATIONS: Record<string, string[]> = {
  darwin: [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    "/usr/local/bin/tailscale",
    "/opt/homebrew/bin/tailscale",
  ],
  linux: ["/usr/bin/tailscale", "/usr/local/bin/tailscale"],
  win32: ["C:\\Program Files\\Tailscale\\tailscale.exe"],
};

/** `$FABDESK_TAILSCALE_CLI`, then PATH, then where the platform installer puts it. */
export function findTailscaleCli(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env[TAILSCALE_CLI_ENV];
  if (override === "off") return null;
  if (override) return existsSync(override) ? override : null;
  const onPath = Bun.which(process.platform === "win32" ? "tailscale.exe" : "tailscale");
  if (onPath) return onPath;
  return (KNOWN_LOCATIONS[process.platform] ?? []).find((p) => existsSync(p)) ?? null;
}

export async function runTailscale(
  cli: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn([cli, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- parsing (pure, so the shapes are testable without the CLI) ---------- */

/** The parts of `tailscale status --json` this module reads. */
interface StatusJson {
  BackendState?: string;
  Self?: { DNSName?: string; TailscaleIPs?: string[] };
  CertDomains?: string[] | null;
  CurrentTailnet?: { MagicDNSEnabled?: boolean } | null;
}

/**
 * `tailscale serve status --json` prints the `ipn.ServeConfig`: `TCP` maps ports to
 * `{ HTTPS: true }` for TLS termination, `Web` maps `<dnsname>:<port>` to `Handlers`, whose
 * `/` entry carries `Proxy: "http://127.0.0.1:47820"`. An empty config is `{}`.
 */
interface ServeJson {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }> | null;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> | null }> | null;
}

export function parseStatus(raw: string): Omit<TailscaleInfo, "cli" | "serves"> {
  const json = JSON.parse(raw) as StatusJson;
  const dns = json.Self?.DNSName?.replace(/\.$/, "") ?? "";
  const magicDns = json.CurrentTailnet?.MagicDNSEnabled ?? dns.length > 0;
  return {
    backendState: json.BackendState ?? "unknown",
    ip: json.Self?.TailscaleIPs?.find((a) => a.includes(".") && !a.includes(":")) ?? null,
    dnsName: magicDns && dns ? dns : null,
    httpsEnabled: (json.CertDomains ?? []).some((d) => d.length > 0),
  };
}

export function parseServeStatus(raw: string): TailscaleServe[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "No serve config") return [];
  const json = JSON.parse(trimmed) as ServeJson;
  const out: TailscaleServe[] = [];
  for (const [hostPort, web] of Object.entries(json.Web ?? {})) {
    const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
    if (!Number.isInteger(port) || json.TCP?.[String(port)]?.HTTPS !== true) continue;
    const target = web.Handlers?.["/"]?.Proxy;
    if (target) out.push({ port, target });
  }
  return out;
}

/** Where `tailscale serve` should send traffic for a listener bound to `host`. */
export function serveTarget(listener: { host: string; port: number }): string {
  const host =
    isWildcardHost(listener.host) || listener.host === "localhost" ? "127.0.0.1" : listener.host;
  return `http://${host.includes(":") ? `[${host}]` : host}:${listener.port}`;
}

/* ---------- provider ---------- */

export function createTailscaleProvider(
  opts: { cli?: string | null; cacheMs?: number } = {},
): TailscaleProvider {
  const cacheMs = opts.cacheMs ?? CACHE_MS;
  let cached: { at: number; cli: string; info: TailscaleInfo | null } | null = null;
  // The env override is read on every probe rather than once: tests point it at a fake binary
  // after this module is loaded, and a user installing Tailscale later gets picked up too.
  const resolveCli = () => (opts.cli !== undefined ? opts.cli : findTailscaleCli());

  const probe = async (cli: string): Promise<TailscaleInfo | null> => {
    const status = await runTailscale(cli, ["status", "--json"]);
    // `status` exits non-zero when logged out or stopped but still prints JSON; only a missing or
    // broken CLI (no JSON at all) makes us fall back to the interface guess.
    let parsed: ReturnType<typeof parseStatus>;
    try {
      parsed = parseStatus(status.stdout);
    } catch (e) {
      logger.warn("tailscale status unreadable", {
        cli,
        exitCode: status.exitCode,
        error: errMsg(e),
        stderr: status.stderr.trim(),
      });
      return null;
    }
    let serves: TailscaleServe[] = [];
    try {
      const serve = await runTailscale(cli, ["serve", "status", "--json"]);
      serves = serve.exitCode === 0 ? parseServeStatus(serve.stdout) : [];
    } catch (e) {
      logger.warn("tailscale serve status failed", { error: errMsg(e) });
    }
    return { cli, ...parsed, serves };
  };

  return {
    async info({ fresh = false } = {}) {
      const cli = resolveCli();
      if (!cli) return null;
      if (!fresh && cached && cached.cli === cli && Date.now() - cached.at < cacheMs)
        return cached.info;
      let info: TailscaleInfo | null = null;
      try {
        info = await probe(cli);
      } catch (e) {
        logger.warn("tailscale probe failed", { cli, error: errMsg(e) });
      }
      cached = { at: Date.now(), cli, info };
      return info;
    },
    async setServe(enabled, target) {
      const cli = resolveCli();
      if (!cli)
        throw new Error("Tailscale CLI not found; install Tailscale on this machine first.");
      const args = enabled
        ? ["serve", "--bg", "https:443", serveTarget(target)]
        : ["serve", "reset"];
      const result = await runTailscale(cli, args);
      cached = null;
      if (result.exitCode !== 0) {
        const detail = (result.stderr || result.stdout).trim();
        const hint = enabled
          ? " Serve needs the tailnet's HTTPS certificates feature: enable it in the Tailscale admin console under DNS."
          : "";
        throw new Error(
          `tailscale ${args.join(" ")} failed (${result.exitCode}): ${detail || "no output"}.${hint}`,
        );
      }
      logger.info("tailscale serve updated", { enabled, args });
    },
  };
}

let shared: TailscaleProvider | null = null;
/** The one provider the daemon shares between listeners and routes. */
export function tailscaleProvider(): TailscaleProvider {
  return (shared ??= createTailscaleProvider());
}
