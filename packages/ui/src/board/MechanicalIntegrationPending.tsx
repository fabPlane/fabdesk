import { useAssistantSurface } from "../chat/useAssistantSurface";
import { IntegrationPending } from "../components/IntegrationPending";
import { Button } from "../components/ui";
import { useUiStore } from "../stores/ui";

/** One adapter to replace when the teammate-owned assembly/enclosure workspace lands. */
export function MechanicalIntegrationPending() {
  const projectId = useUiStore(state => state.activeProjectId);
  useAssistantSurface(projectId ? { projectId, label: "Mechanical · Awaiting integration", priority: 10, details: JSON.stringify({ state: "awaiting-teammate-integration", features: ["3D assembly", "enclosure import", "enclosure generation"], instruction: "This is a placeholder, not a live assembly or a generated enclosure. Existing board sources and saved outputs remain available. Do not claim enclosure edits, model compatibility or fit checks." }) } : null);
  return <div className="fd-mechanical-integration" data-testid="mechanical-integration-pending"><IntegrationPending feature="enclosure" /><div className="fd-integration-next-actions"><Button onClick={() => useUiStore.getState().setBoardTab("pcb")}>Open board workspace</Button><Button variant="ghost" onClick={() => useUiStore.getState().setBoardTab("renders")}>Saved outputs</Button></div><p>Existing sources and models are preserved. Continue with the rest of your project while this workspace is prepared.</p></div>;
}
