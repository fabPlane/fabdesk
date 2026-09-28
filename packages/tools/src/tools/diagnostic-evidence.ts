/** Model-visible provenance for diagnostics returned by the live KiCad bridge session. */

export type SessionDiagnosticCounts = { errors: number; warnings: number };

export function kicadIpcSessionDiagnostics(counts: SessionDiagnosticCounts): {
  source: "kicad-ipc-session";
  scope: "current live schematic session";
  authority: "informational-not-saved-file-erc";
  counts: SessionDiagnosticCounts;
} {
  return {
    source: "kicad-ipc-session",
    scope: "current live schematic session",
    authority: "informational-not-saved-file-erc",
    counts,
  };
}

export function formatKicadIpcSessionDiagnostics(counts: SessionDiagnosticCounts): string {
  return `KiCad IPC session diagnostics (informational; not saved-file ERC): ${counts.errors} errors, ${counts.warnings} warnings.`;
}
