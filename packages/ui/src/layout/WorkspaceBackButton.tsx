import { useEffect } from "react";
import { useCoreClient, WORKSPACE_AREAS } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { Button } from "../components/ui";
import { Icon } from "../components/Icon";

export function WorkspaceBackButton() {
  const client = useCoreClient();
  const previous = useUiStore(state => state.navigationHistory.at(-1));
  const projectId = useUiStore(state => state.activeProjectId);
  useEffect(() => { useUiStore.getState().setNavigationEndpoint(client.baseUrl); }, [client.baseUrl]);
  if (!previous || previous.projectId !== projectId) return null;
  const label = previous.orderFlowOpen ? "Order preparation" : previous.inventoryOpen ? "Inventory" : previous.openSourceId ? "Open source" : WORKSPACE_AREAS[previous.area].label;
  return <Button className="fd-workspace-back" size="sm" title={`Back to ${label}`} aria-label={`Back to ${label}`} onClick={() => useUiStore.getState().navigateBack()}><Icon name="chevronLeft" width={16} height={16} /><span>Back</span></Button>;
}
