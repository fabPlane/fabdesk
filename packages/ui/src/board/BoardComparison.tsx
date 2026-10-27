import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { SvgTab } from "./SvgTab";

/** One PCB and one schematic from the same project; opening comparison never synchronizes them. */
export function BoardComparison({ projectId, active }: { projectId: string; active: "pcb" | "schematic" }) {
  const focus = (kind: "pcb" | "schematic") => { if (useUiStore.getState().activeProjectId === projectId && useUiStore.getState().boardTab !== kind) useUiStore.getState().setWorkspaceTab(kind); };
  return <div className="fd-board-comparison" data-testid="board-comparison">
    <PanelGroup direction="horizontal" autoSaveId={`fabplane-board-comparison-${projectId}`}>
      <Panel id="pcb" order={1} defaultSize={50} minSize={25}>
        <section className="fd-comparison-pane" data-view="pcb" data-active={active === "pcb"} aria-label="PCB comparison pane" onPointerDownCapture={() => focus("pcb")} onFocusCapture={() => focus("pcb")}>
          <header><Button size="sm" variant="ghost" aria-pressed={active === "pcb"} onClick={() => focus("pcb")}>PCB</Button><span>Saved board preview</span></header>
          <div className="fd-comparison-drawing"><SvgTab kind="pcb" active={active === "pcb"} /></div>
        </section>
      </Panel>
      <PanelResizeHandle className="fd-comparison-divider" aria-label="Resize PCB and schematic views" />
      <Panel id="schematic" order={2} defaultSize={50} minSize={25}>
        <section className="fd-comparison-pane" data-view="schematic" data-active={active === "schematic"} aria-label="Schematic comparison pane" onPointerDownCapture={() => focus("schematic")} onFocusCapture={() => focus("schematic")}>
          <header><Button size="sm" variant="ghost" aria-pressed={active === "schematic"} onClick={() => focus("schematic")}>Schematic</Button><span>Saved preview · Freshness unverified</span></header>
          <div className="fd-comparison-drawing"><SvgTab kind="schematic" active={active === "schematic"} /></div>
        </section>
      </Panel>
    </PanelGroup>
  </div>;
}
