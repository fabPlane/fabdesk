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

export interface Admission {
  release(): void;
}
export type ResourceKind = "light" | "router" | "tracemaker";

export interface LayoutHost {
  tools: LayoutTools;
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

export async function admitted<T>(host: LayoutHost, kind: ResourceKind, label: string, paths: string[], fn: () => Promise<T>): Promise<T> {
  const a = host.admit ? await host.admit(kind, label, paths) : { release() {} };
  try {
    return await fn();
  } finally {
    a.release();
  }
}
