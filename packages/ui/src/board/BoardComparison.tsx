import { useMemo, useState, useLayoutEffect, useRef, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { SvgTab } from "./SvgTab";
import { ThreeDTab } from "./ThreeDTab";
import { useBoardPartSelection } from "./usePartSelection";
import { ComparisonControls } from "./ComparisonControls";
import "./three-view.css";

type View = "pcb" | "schematic" | "3d";
const labels = { pcb: "PCB", schematic: "Schematic", "3d": "3D" };

function Pane({ view, active, onFocus, children }: { view: View; active: View; onFocus: (view: View) => void; children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const controls = useMemo(() => ({ target, label: labels[view] }), [target, view]);
  return <section className="fd-comparison-pane" data-view={view} data-active={active === view} aria-label={`${labels[view]} comparison pane`} onPointerDownCapture={() => onFocus(view)} onFocusCapture={() => onFocus(view)}>
    <header><Button size="sm" variant="ghost" aria-pressed={active === view} onClick={() => onFocus(view)}>{labels[view]}</Button><div ref={setTarget} className="fd-comparison-part-actions" /><Button size="sm" variant="ghost" aria-label={`Expand ${labels[view]}`} title={`View ${labels[view]} on its own`} onClick={() => { onFocus(view); useUiStore.getState().setBoardComparison(false); }}>↗</Button></header>
    <ComparisonControls.Provider value={controls}><div className="fd-comparison-drawing">{children}</div></ComparisonControls.Provider>
  </section>;
}

/** Three source-bound views; changing pane focus never unmounts the other previews. */
export function BoardComparison({ projectId, active, onOpenChecks }: { projectId: string; active: View; onOpenChecks?: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(false);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => setColumns(element.clientHeight < 560);
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const selection = useBoardPartSelection({ projectId });
  const references = useMemo(() => [...new Set([...(selection.index.data?.pcb?.parts ?? []), ...(selection.index.data?.sheets.flatMap(sheet => sheet.parts) ?? [])].map(part => part.ref))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [selection.index.data]);
  const focus = (view: View) => { if (useUiStore.getState().activeProjectId === projectId && useUiStore.getState().boardTab !== view) useUiStore.getState().setWorkspaceTab(view); };
  return <div ref={host} className="fd-board-comparison fd-three-view" data-layout={columns ? "columns" : "stacked"} data-testid="board-comparison" onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented && selection.ref && !(event.target instanceof Element && event.target.closest("input,textarea,select,[role=dialog],[role=menu]"))) { selection.clear(); event.preventDefault(); }
  }}>
    <div className="fd-part-selection-bar fd-shared-part-selection" data-testid="shared-part-selection">
      <select aria-label="Selected component across views" disabled={!selection.ready} value={references.includes(selection.ref ?? "") ? selection.ref! : ""} onChange={event => event.target.value ? selection.select(event.target.value) : selection.clear()}>
        <option value="">Select a part…</option>{references.map(ref => <option key={ref} value={ref}>{ref}</option>)}
      </select>
      <span role="status">{selection.index.isError ? "Component selection unavailable" : !selection.ready ? "Loading components…" : selection.ref ? `${selection.ref} selected · PCB, schematic & 3D` : "Click a part in any view to highlight it in all three"}</span>
      {selection.ref && <Button size="sm" variant="ghost" onClick={selection.clear}>Clear</Button>}
    </div>
    <div className="fd-three-view-panes">
      <PanelGroup direction="horizontal" keyboardResizeBy={5} autoSaveId={`fabplane-three-view-columns-${columns ? "short" : "tall"}-${projectId}`}>
        <Panel id="pcb" order={1} defaultSize={columns ? 33 : 42} minSize={columns ? 28 : 32} maxSize={columns ? 36 : 60}>
          <Pane view="pcb" active={active} onFocus={focus}><SvgTab {...(onOpenChecks ? { onOpenChecks } : {})} kind="pcb" active={active === "pcb"} /></Pane>
        </Panel>
        <PanelResizeHandle className="fd-comparison-divider" aria-label="Resize PCB and other views" />
        <Panel id="other-views" order={2} defaultSize={columns ? 67 : 58} minSize={columns ? 64 : 40}>
          <PanelGroup direction={columns ? "horizontal" : "vertical"} keyboardResizeBy={5} autoSaveId={`fabplane-three-view-rows-${columns ? "short" : "tall"}-${projectId}`}>
            <Panel id="schematic" order={1} defaultSize={50} minSize={columns ? 45 : 40}>
              <Pane view="schematic" active={active} onFocus={focus}><SvgTab kind="schematic" active={active === "schematic"} /></Pane>
            </Panel>
            <PanelResizeHandle className={`fd-comparison-divider${columns ? "" : " fd-comparison-divider-horizontal"}`} aria-label="Resize schematic and 3D views" />
            <Panel id="3d" order={2} defaultSize={50} minSize={columns ? 45 : 40}>
              <Pane view="3d" active={active} onFocus={focus}><ThreeDTab compact active={active === "3d"} /></Pane>
            </Panel>
          </PanelGroup>
        </Panel>
      </PanelGroup>
    </div>
  </div>;
}
