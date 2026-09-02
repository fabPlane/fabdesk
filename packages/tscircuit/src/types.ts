import type { SimpleRouteJson } from "@fabdesk/protocol";

export interface BuildError {
  type: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface BuildResult {
  ok: boolean;
  circuitJson: unknown[];
  errors: BuildError[];
  warnings: string[];
  elementCounts: Record<string, number>;
  durationMs: number;
}

export interface BuildOptions {
  projectDir: string;
  /** File under projectDir to evaluate. Defaults to "circuit.tsx". */
  entrypoint?: string;
  /** Directory for the render-phase cache and cached registry (@tsci/*) fetches. */
  cacheDir?: string;
  signal?: AbortSignal;
}

export type CircuitSelect = "components" | "nets" | "ports" | "traces" | "errors";

export interface ExtractedSrj {
  srj: SimpleRouteJson;
  /**
   * SRJ connection name -> the source element it routes: a `source_trace_id`, or the
   * `source_net_id` for connections core derives from net selectors (`to="net.GND"`).
   */
  connectionMap: Record<string, string>;
}

/** Minimal view of a circuit-json element used throughout this package. */
export type Element = { type: string } & Record<string, unknown>;

export function asElements(circuitJson: unknown[]): Element[] {
  return circuitJson.filter(
    (e): e is Element => typeof e === "object" && e !== null && typeof (e as { type?: unknown }).type === "string",
  );
}
