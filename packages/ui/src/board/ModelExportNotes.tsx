import { askAboutSurface } from "../chat/useAssistantSurface";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { DisclosureSummary } from "../components/DisclosureSummary";

/** Interpret only the exporter's explicit reference warning; unknown notes stay verbatim. */
export function missingModelReferences(warnings: readonly string[]) {
  return [...new Set(warnings.flatMap(warning => {
    const match = /^Could not add 3D model for ([A-Za-z][A-Za-z0-9_/-]*)\.$/.exec(warning.trim());
    return match?.[1] ? [match[1]] : [];
  }))];
}

export function ModelExportNotes({ projectId, warnings, modelProjectDirectory, path = "renders/board.glb", sourceId, manifestSha256 }: { projectId: string; warnings: readonly string[]; modelProjectDirectory?: string | undefined; path?: string; sourceId?: string; manifestSha256?: string }) {
  const missing = missingModelReferences(warnings);
  const surface = { projectId, label: "3D model export notes", priority: 50, details: JSON.stringify({ path, sourceId, manifestSha256, modelProjectDirectory, warnings }) };
  return <div className="fd-model-export-notes">
    {warnings.length > 0 && <div className="fd-model-export-summary"><div>
      <strong>{missing.length ? `${missing.length} component ${missing.length === 1 ? "model" : "models"} missing` : "Model export needs review"}</strong>
      <p>{missing.length ? `The exporter could not include models for ${missing.join(", ")}. Review these before relying on appearance or physical fit.` : "The exporter reported notes about this saved model. Review the details before relying on the preview."}</p>
    </div><CanvasToolButton icon="sparkles" label="Ask about model warnings" onClick={() => askAboutSurface(surface, "Explain the warnings for this saved 3D preview and how to resolve missing component models. Inspect the model paths and available libraries; do not replace components or change footprints, routing or circuit files without my review.")} /></div>}
    <details className="fd-model-export-details">
      <DisclosureSummary icon={warnings.length ? "warning" : "folderOpen"} label="Export details" variant="compact" warning={warnings.length > 0} badge={warnings.length ? `${warnings.length} notes` : undefined} />
      {modelProjectDirectory && <p>Imported component-model folder: <code>{modelProjectDirectory}</code>. This records the export context; component files and full model coverage remain unverified.</p>}
      {warnings.length > 0 && <><p>Original exporter messages:</p><ul>{warnings.map((message, index) => <li key={index}>{message}</li>)}</ul></>}
    </details>
  </div>;
}
