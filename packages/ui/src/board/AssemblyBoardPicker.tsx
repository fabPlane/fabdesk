import type { ProjectBoardSources } from "@fabdesk/protocol";
import { assemblySelectionState, captureAssemblySelection, type AssemblySceneSelection } from "@fabdesk/client-core";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";

/** Physical board identity stays visible in every board task, including shared-source instances. */
export function AssemblyBoardPicker({ projectId, data, selection, disabled, onChoose, onBack }: { projectId: string; data: ProjectBoardSources; selection: AssemblySceneSelection | null; disabled: boolean; onChoose: (selection: AssemblySceneSelection) => void; onBack: () => void }) {
  const name = data.assembly?.instances.find(row => row.id === selection?.instanceId)?.name ?? "Choose board";
  return <WorkspaceMenu className="fd-assembly-board-picker" label={<><span aria-label="Switch board">{name}</span><Icon name="chevronDown" width={16} height={16} /></>}>
    <button disabled={disabled} onClick={() => { if (!disabled && useUiStore.getState().activeProjectId === projectId) onBack(); }}>← All boards</button>
    <div className="fd-menu-divider" /><div className="fd-menu-caption">Switch board</div>
    {data.assembly?.instances.map(instance => {
      const next = captureAssemblySelection(data, instance.id), available = next && assemblySelectionState(data, next) === "owned", selected = next?.instanceId === selection?.instanceId;
      return <button key={instance.id} aria-current={selected ? "true" : undefined} disabled={disabled || !available || selected} title={!available ? "Source unavailable; resolve it from the project overview" : undefined} onClick={() => {
        if (!disabled && next && assemblySelectionState(data, next) === "owned" && useUiStore.getState().activeProjectId === projectId) onChoose(next);
      }}><span>{instance.name}{!available && <small>Source unavailable</small>}</span>{selected && <Icon name="check" width={15} height={15} />}</button>;
    })}
    {disabled && <p className="fd-menu-caption">Finish the current board operation before switching.</p>}
  </WorkspaceMenu>;
}
