import { runAllChecks } from "@tscircuit/checks";
import type { AnyCircuitElement } from "circuit-json";

export interface CheckError {
  type: string;
  message: string;
  [k: string]: unknown;
}

/**
 * Runs every @tscircuit/checks rule (placement, schematic, netlist, pin specification, routing).
 * Async because `runAllChecks` is; the contract's synchronous signature is not achievable without
 * re-implementing the upstream composition (it uses an un-exported check).
 */
export async function runChecks(circuitJson: unknown[]): Promise<{ errors: CheckError[] }> {
  const results = await runAllChecks(circuitJson as AnyCircuitElement[]);
  const errors: CheckError[] = results.map((r) => {
    const el = r as unknown as Record<string, unknown>;
    return {
      ...el,
      type: String(el.type ?? el.error_type ?? "unknown"),
      message: typeof el.message === "string" ? el.message : String(el.error_type ?? el.type),
    };
  });
  return { errors };
}
