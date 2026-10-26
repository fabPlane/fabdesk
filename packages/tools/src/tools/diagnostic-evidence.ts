/** Model-visible provenance for diagnostics returned by the live KiCad bridge session. */

export type SessionDiagnosticCounts = {
  errors: number;
  warnings: number;
  issues?: Array<{ type: string; description: string; itemIds: string[] }>;
  issueCount?: number;
  danglingItemIds?: string[];
};

export function kicadIpcSessionDiagnostics(counts: SessionDiagnosticCounts): {
  source: "kicad-ipc-session";
  scope: "current live schematic session";
  authority: "informational-not-saved-file-erc";
  counts: SessionDiagnosticCounts;
  issues?: SessionDiagnosticCounts["issues"];
  issueCount?: number;
  danglingItemIds?: string[];
} {
  return {
    source: "kicad-ipc-session",
    scope: "current live schematic session",
    authority: "informational-not-saved-file-erc",
    counts: { errors: counts.errors, warnings: counts.warnings },
    ...(counts.issues ? { issues: counts.issues } : {}),
    ...(counts.issueCount !== undefined ? { issueCount: counts.issueCount } : {}),
    ...(counts.danglingItemIds ? { danglingItemIds: counts.danglingItemIds } : {}),
  };
}

export function formatKicadIpcSessionDiagnostics(counts: SessionDiagnosticCounts): string {
  return `KiCad IPC session diagnostics (informational; not saved-file ERC): ${counts.errors} errors, ${counts.warnings} warnings.`;
}
