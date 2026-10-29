import type { ProjectBomLine } from "./parts";

/** Saved-source coverage, separate from electrical parity, purchasing or release readiness. */
export interface BomSourceCoverage {
  sourceId: string | null;
  name: string;
  directory: string;
  instanceIds: string[];
  multiplier: number;
  status: "native-schematic" | "saved-netlist" | "missing-schematic" | "unavailable" | "failed" | "unused";
  componentCount: number;
  reason?: string;
  sourceRevision?: string;
}

export interface ProjectBomSnapshot {
  contract: "fabplane.project-bom.v1";
  projectId: string;
  manifestSha256: string | null;
  revision: string;
  capturedAt: string;
  lines: ProjectBomLine[];
  coverage: BomSourceCoverage[];
  complete: boolean;
  inputs: Array<{ path: string; sha256: string }>;
  absentInputs: string[];
  notes: string[];
}
