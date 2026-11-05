import { askAboutSurface } from "../chat/useAssistantSurface";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import { DisclosureSummary } from "../components/DisclosureSummary";

/** Interpret only the exporter's explicit reference warning; unknown notes stay verbatim. */
export function missingModelReferences(warnings: readonly string[]) {
  return [...new Set(warnings.flatMap(warning => {
    const match = /^Could not add 3D model for ([A-Za-z][A-Za-z0-9_/-]*)\.$/.exec(warning.trim());
    return match?.[1] ? [match[1]] : [];
  }))];
}

export function ModelExportNotes({ projectId, warnings, modelProjectDirectory, path = "renders/board.glb", sourceId, manifestSha256, onAsk }: { onAsk?: (() => void) | undefined; projectId: string; warnings: readonly string[]; modelProjectDirectory?: string | undefined; path?: string; sourceId?: string; manifestSha256?: string }) {
  const missing = missingModelReferences(warnings);
  const surface = { projectId, label: "3D model export notes", priority: 50, details: JSON.stringify({ path, sourceId, manifestSha256, modelProjectDirectory, warnings, instruction: "Find exact models using saved footprint model paths and local libraries first. Explain missing inputs and verified matches. Keep components, footprints, routing and circuit files unchanged; do not imply model completeness or physical fit is verified." }) };
  return <div className="fd-model-export-notes">
    {warnings.length > 0 && <div className="fd-model-export-summary"><div>
      <strong>{missing.length ? `${missing.length} component ${missing.length === 1 ? "model" : "models"} missing` : "Model export needs review"}</strong>
      <p>{missing.length ? `The exporter could not include models for ${missing.join(", ")}. Review these before relying on appearance or physical fit.` : "The exporter reported notes about this saved model. Review the details before relying on the preview."}</p>
    </div></div>}
    {warnings.length > 0 && <div className="fd-model-export-next-step">
      <Button size="sm" title="Prepare a request in Ask fabPlane" onClick={() => {
        askAboutSurface(surface, missing.length
          ? `Help me find the exact 3D models for ${missing.join(" and ")}. Check available libraries and tell me what is needed to complete this preview.`
          : "Help me resolve this 3D preview’s export warnings. What should I do next?");
        onAsk?.();
      }}><Icon name="sparkles" width={16} height={16} />{missing.length ? "Find missing models" : "Ask how to resolve"}</Button>
      <p>Review and send the prepared request in Ask fabPlane. You can keep inspecting or export this incomplete preview. Resolve missing models before relying on component appearance or fit.</p>
    </div>}

    <details className="fd-model-export-details">
      <DisclosureSummary icon={warnings.length ? "warning" : "folderOpen"} label={missing.length ? "Review missing models" : "Export details"} variant="compact" warning={warnings.length > 0} />
      {missing.length > 0 && <>
        <ul className="fd-model-missing-list" aria-label="Components missing 3D models">{missing.map(reference => <li key={reference}><strong>{reference}</strong><span>3D model not included</span></li>)}</ul>
        <p className="fd-model-missing-help">The PCB still contains these components. Their bodies are absent from this preview.</p>
      </>}
      {modelProjectDirectory && <p>Imported component-model folder: <code>{modelProjectDirectory}</code>. This records the export context; component files and full model coverage remain unverified.</p>}
      {warnings.length > 0 && <details className="fd-model-export-technical">
        <DisclosureSummary icon="terminal" label="Technical details" variant="compact" />
        <p>Original exporter messages, including file paths:</p>
        <pre>{warnings.join("\n")}</pre>
      </details>}
    </details>
  </div>;
}
