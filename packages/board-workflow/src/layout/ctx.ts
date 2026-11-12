/** What the layout stages need from their host: engine locations, process running, DRC, admission. */
import type { DrcInput } from "../accept";
import type { Spawn } from "./engines";

export interface LayoutTools {
  /** KiCadRoutingTools build (has `src/plugins` and `venv/bin/python`); null when not configured. */
  krt: string | null;
  /** TraceMaker binary from the router registry or `TRACEMAKER_BIN`; null when not installed. */
  tracemaker: string | null;
  kicadCli: string | null;
}

/** The engines a host can install on first use. */
export type EngineId = "krt" | "tracemaker";

/** What the host's `ensure` found or did: the path to run, or why there is none (phrased for the agent). */
export interface EngineReady {
  path: string | null;
  why?: string;
}

export interface Admission {
  release(): void;
}
export type ResourceKind = "light" | "router" | "tracemaker";

export interface LayoutHost {
  tools: LayoutTools;
  /**
   * Install a missing engine on first use (the host's router registry) and return its path; absent means engines are
   * only what `tools` says. Never called for an engine `tools` already names (a set override is used, or fails, as given).
   */
  ensure?(engine: EngineId): Promise<EngineReady>;
  spawn: Spawn;
  /** Courtyard gate: KiCad DRC, all severities, no refill, no parity. Rows are `{rule, items[].description}`. */
  courtyardDrc(board: string, report: string): Promise<Array<{ rule: string; items: Array<{ description: string }> }>>;
  /** Scoring DRC: refilled zones, optionally schematic parity. */
  scoreDrc(board: string, outFile: string, parity: boolean): Promise<DrcInput>;
  /** Resource-class admission (the governor); default: admit at once. */
  admit?(kind: ResourceKind, label: string, paths: string[]): Promise<Admission>;
  /** GiB of memory available now. */
  memAvailableGiB(): Promise<number>;
  diskFreeGiB(path: string): Promise<number>;
  /** True while a TraceMaker process runs anywhere on the machine. */
  tracemakerBusy?(): Promise<boolean>;
  /** Progress lines, as they happen. */
  log?(line: string): void;
  signal?: AbortSignal;
  onPid?(pid: number): void;
  now?(): number;
}

export class FlowError extends Error {}

/** `host.tools[engine]`, installed through the host first when it is missing (the path is kept in `tools`). */
export async function engineReady(host: LayoutHost, engine: EngineId): Promise<EngineReady> {
  const have = host.tools[engine];
  if (have || !host.ensure) return { path: have };
  const r = await host.ensure(engine);
  if (r.path) host.tools[engine] = r.path;
  return r.path ? { path: r.path } : { path: null, ...(r.why ? { why: r.why } : {}) };
}

/** The engine's path, or a FlowError naming why it is missing (the install's own reason when one was tried). */
export async function requireEngine(host: LayoutHost, engine: EngineId): Promise<string> {
  const r = await engineReady(host, engine);
  if (r.path) return r.path;
  const name = engine === "krt" ? "KiCadRoutingTools" : "TraceMaker";
  throw new FlowError(r.why ?? `${name} is not installed (board_engines install ${engine}, Settings → Routers, or ${engine === "krt" ? "FABDESK_KRT_DIR" : "TRACEMAKER_BIN"})`);
}

export async function admitted<T>(host: LayoutHost, kind: ResourceKind, label: string, paths: string[], fn: () => Promise<T>): Promise<T> {
  const a = host.admit ? await host.admit(kind, label, paths) : { release() {} };
  try {
    return await fn();
  } finally {
    a.release();
  }
}
