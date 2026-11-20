import { askAboutSurface } from "../chat/useAssistantSurface";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";
import { inspectModelWarnings } from "./model-warnings";

export function ModelExportNotes({ projectId, warnings, modelProjectDirectory, path = "renders/board.glb", sourceId, manifestSha256, onAsk }: { onAsk?: (() => void) | undefined; projectId: string; warnings: readonly string[]; modelProjectDirectory?: string | undefined; path?: string; sourceId?: string; manifestSha256?: string }) {
  const { references, byFile, ungrouped } = inspectModelWarnings(warnings);
  const surface = { projectId, label: "3D model export notes", priority: 50, details: JSON.stringify({ path, sourceId, manifestSha256, modelProjectDirectory, warnings, instruction: "Find exact models using saved footprint model paths and local libraries first. Explain missing inputs and verified matches. Keep components, footprints, routing and circuit files unchanged; do not imply model completeness or physical fit is verified." }) };
  return <div className="fd-model-export-notes">
    {references.length > 0 && <ul className="fd-model-warning-groups" aria-label="Placements missing 3D geometry">
      {[...byFile].map(([file, refs]) => <li key={file}><strong title={file}>{file.split(/[\\/]/).at(-1)}</strong><span>{[...refs].join(", ")}</span></li>)}
      {ungrouped.length > 0 && <li><strong>Model file unspecified</strong><span>{ungrouped.join(", ")}</span></li>}
    </ul>}
    {warnings.length > 0 && <Button size="sm" variant="secondary" onClick={() => {
      askAboutSurface(surface, references.length
        ? `Help me find the exact 3D models for ${references.join(", ")}.`
        : "Help me resolve this 3D preview’s export warnings.");
      onAsk?.();
    }}><Icon name="sparkles" width={16} height={16} />{references.length ? "Find missing models" : "Ask about warnings"}</Button>}
    <details className="fd-model-export-technical"><summary>Technical details</summary>
      {modelProjectDirectory && <p>Model folder <code>{modelProjectDirectory}</code></p>}
      {warnings.length > 0 && <pre>{warnings.join("\n")}</pre>}
    </details>
  </div>;
}
