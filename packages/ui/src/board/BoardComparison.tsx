import { createPortal } from "react-dom";
import { useMemo, useState, useLayoutEffect, useRef, useCallback, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { PartPicker } from "./PartPicker";
import { Button } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { SvgTab } from "./SvgTab";
import { ThreeDTab } from "./ThreeDTab";
import { useBoardPartSelection } from "./usePartSelection";
import { ComparisonControls, type ComparisonFocus } from "./ComparisonControls";
import "./three-view.css";

type View = "pcb" | "schematic" | "3d";
const labels = { pcb: "PCB drawing", schematic: "Schematic", "3d": "3D" };

function Pane({ view, active, onExpand, onFocus, children, focus, onSelect }: { view: View; active: View; onExpand?: () => void; onFocus: (view: View) => void; children: ReactNode; focus: ComparisonFocus | null; onSelect: (ref: string, origin: View | null) => void }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const controls = useMemo(() => ({ target, label: labels[view], view, focus, onSelect }), [target, view, focus, onSelect]);
  return <section className="fd-comparison-pane" data-view={view} data-active={active === view} aria-label={`${labels[view]} comparison pane`} onPointerDownCapture={() => onFocus(view)} onFocusCapture={() => onFocus(view)}>
    <header><Button size="sm" variant="ghost" aria-pressed={active === view} onClick={() => onFocus(view)}>{labels[view]}</Button><div ref={setTarget} className="fd-comparison-part-actions" /><Button size="sm" variant="ghost" aria-label={`Expand ${labels[view]}`} title={`View ${labels[view]} on its own`} onClick={() => { onFocus(view); onExpand?.(); useUiStore.getState().setBoardComparison(false); }}>↗</Button></header>
    <ComparisonControls.Provider value={controls}><div className="fd-comparison-drawing">{children}</div></ComparisonControls.Provider>
  </section>;
}

/** Three source-bound views; changing pane focus never unmounts the other previews. */
export function BoardComparison({ projectId, active, onOpenChecks, onExpandPcb, twoPanes, toolbar }: { toolbar: HTMLDivElement | null; projectId: string; twoPanes: boolean; onExpandPcb: () => void; active: View; onOpenChecks?: () => void }) {
  const [linkedFocus, setLinkedFocus] = useState<ComparisonFocus | null>(null);
  const sequence = useRef(0);
  const followSelection = useCallback((ref: string, origin: View | null) => setLinkedFocus({ ref, origin, id: ++sequence.current }), []);
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
  const references = useMemo(() => [...new Set([...(selection.index.data?.model?.references ?? []), ...(selection.index.data?.pcb?.parts.map(part => part.ref) ?? []), ...(selection.index.data?.sheets.flatMap(sheet => sheet.parts.map(part => part.ref)) ?? [])])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })), [selection.index.data]);
  const focus = (view: View) => { if (useUiStore.getState().activeProjectId === projectId && useUiStore.getState().boardTab !== view) useUiStore.getState().setWorkspaceTab(view); };
  const modelPane = <Pane view="3d" active={active} onFocus={focus} focus={linkedFocus} onSelect={followSelection}><ThreeDTab compact active={active === "3d"} /></Pane>;
  return <div ref={host} className="fd-board-comparison fd-three-view" data-layout={twoPanes ? "pair" : columns ? "columns" : "stacked"} data-testid="board-comparison" onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented && selection.ref && !(event.target instanceof Element && event.target.closest("input,textarea,select,[role=dialog],[role=menu]"))) { selection.clear(); event.preventDefault(); }
  }}>
    {toolbar && createPortal(
      <div className="fd-part-selection-bar fd-shared-part-selection" data-testid="shared-part-selection">
        <PartPicker primary reference={selection.ref} references={references} values={selection.values} disabled={!selection.ready}
          onSelect={ref => { selection.select(ref); followSelection(ref, null); }} onClear={selection.clear}>
          {selection.ref && <Button size="sm" disabled={!selection.ready} onClick={() => followSelection(selection.ref!, null)}>Focus</Button>}
        </PartPicker>
        {!selection.ready && <span role="status">{selection.index.isError ? "Component selection unavailable" : "Loading components…"}</span>}
      </div>, toolbar)}
    <div className="fd-three-view-panes">
      <PanelGroup direction="horizontal" keyboardResizeBy={5} key={twoPanes ? "two" : "three"} autoSaveId={`fabplane-${twoPanes ? "two" : "three"}-view-columns-${columns ? "short" : "tall"}-${projectId}`}>
        <Panel id="pcb" order={1} defaultSize={twoPanes ? 50 : columns ? 33 : 42} minSize={twoPanes || columns ? 28 : 32} maxSize={twoPanes ? 72 : columns ? 36 : 60}>
          <Pane view="pcb" onExpand={onExpandPcb} active={active} onFocus={focus} focus={linkedFocus} onSelect={followSelection}><SvgTab {...(onOpenChecks ? { onOpenChecks } : {})} kind="pcb" active={active === "pcb"} /></Pane>
        </Panel>
        <PanelResizeHandle className="fd-comparison-divider" aria-label="Resize PCB and other views" />
        <Panel id="other-views" order={2} defaultSize={twoPanes ? 50 : columns ? 67 : 58} minSize={twoPanes ? 28 : columns ? 64 : 40}>
          {twoPanes ? modelPane : <PanelGroup direction={columns ? "horizontal" : "vertical"} keyboardResizeBy={5} autoSaveId={`fabplane-three-view-rows-${columns ? "short" : "tall"}-${projectId}`}>
            <Panel id="schematic" order={1} defaultSize={50} minSize={columns ? 45 : 40}>
              <Pane view="schematic" active={active} onFocus={focus} focus={linkedFocus} onSelect={followSelection}><SvgTab kind="schematic" active={active === "schematic"} /></Pane>
            </Panel>
            <PanelResizeHandle className={`fd-comparison-divider${columns ? "" : " fd-comparison-divider-horizontal"}`} aria-label="Resize schematic and 3D views" />
            <Panel id="3d" order={2} defaultSize={50} minSize={columns ? 45 : 40}>
              {modelPane}
            </Panel>
          </PanelGroup>}
        </Panel>
      </PanelGroup>
    </div>
  </div>;
}
