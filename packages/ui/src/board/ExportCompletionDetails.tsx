import type { FileExportKind } from "./file-exports";

/** Display the existing exporter's result; saving a file does not clear its review notes. */
export function ExportCompletionDetails({ kind, result }: { kind: FileExportKind; result: unknown }) {
  if (!result || typeof result !== "object" || !("json" in result)) return null;
  const json = result.json;
  if (!json || typeof json !== "object") return null;
  if (kind === "export_zip") {
    const files = "files" in json && Array.isArray(json.files) ? json.files.filter((file): file is string => typeof file === "string") : [];
    const missing = "missing" in json && Array.isArray(json.missing) ? json.missing.filter((file): file is string => typeof file === "string") : [];
    return <p>{files.length} saved files packaged{missing.length ? ` · Not included: ${missing.join(", ")}` : ""}</p>;
  }
  if (kind !== "export_stencil" && kind !== "export_laser_stencil") return null;
  const apertureCount = "apertureCount" in json && typeof json.apertureCount === "number" && Number.isFinite(json.apertureCount) && json.apertureCount >= 0 ? json.apertureCount : null;
  const warnings = "warnings" in json && Array.isArray(json.warnings) ? json.warnings.flatMap(warning => warning && typeof warning === "object" && "message" in warning && typeof warning.message === "string" && warning.message.trim() ? [warning.message] : []) : [];
  return <div className="space-y-2">
    {apertureCount !== null && <p>{apertureCount} paste {apertureCount === 1 ? "opening" : "openings"} exported. Review the saved stencil preview before use.</p>}
    {warnings.length > 0 && <div role="note" className="rounded-lg border border-warning/30 bg-warning/5 p-3 text-warning"><strong>Export notes · {warnings.length}</strong><ul className="mt-2 max-h-48 list-disc space-y-1 overflow-auto pl-5">{warnings.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}
  </div>;
}
