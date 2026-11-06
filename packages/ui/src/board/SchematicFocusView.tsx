import { useEffect, useMemo, useState } from "react";
import { schematicFocusFilesMatch, schematicFocusHierarchyMatches, schematicFocusScope, useBoardSources, useCoreClient, useProjectText } from "@fabdesk/client-core";
import type { SchematicFocus } from "@fabdesk/protocol";
import { Button, Spinner } from "../components/ui";
import { useUiStore } from "../stores/ui";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { SvgViewer } from "./SvgViewer";
import { parseSvgViewBox } from "./svg-coords";

/** Overlay leaves the prior drawing mounted, preserving its exact zoom/scroll for Return. */
export function SchematicFocusView({ focus, endpoint }: { focus: SchematicFocus; endpoint: string }) {
  const client = useCoreClient(), sources = useBoardSources(endpoint === client.baseUrl ? focus.projectId : null), source = useProjectText(endpoint === client.baseUrl ? focus.projectId : null, focus.sourcePath), drawing = useProjectText(endpoint === client.baseUrl ? focus.projectId : null, focus.svgPath);
  const [verified, setVerified] = useState<{ source: string; svg: string; matches: boolean } | null>(null), [displayed, setDisplayed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true; setDisplayed(false); setVerified(null);
    if (endpoint === client.baseUrl && source.data && drawing.data) {
      const sourceText = source.data, svg = drawing.data;
      void Promise.all([schematicFocusFilesMatch(focus, sourceText, svg), schematicFocusHierarchyMatches(focus, path => client.readFile(focus.projectId, path))]).then(results => {
        const matches = results.every(Boolean);
        if (current) setVerified({ source: sourceText, svg, matches });
      }).catch(() => { if (current) setVerified({ source: sourceText, svg, matches: false }); });
    }
    return () => { current = false; };
  }, [focus.id, focus.sourceSha256, focus.svgSha256, client.baseUrl, endpoint, source.data, drawing.data, sources.data?.observedAt, attempt]);
  const checking = endpoint === client.baseUrl && (source.isFetching || drawing.isFetching || !!(source.data && drawing.data && !verified));
  const scope = sources.data && !sources.isFetching && !sources.isError ? schematicFocusScope(focus, sources.data) : null;
  const ready = !!scope && verified?.matches && !source.isFetching && !drawing.isFetching && !source.isError && !drawing.isError && verified?.source === source.data && verified?.svg === drawing.data;
  const box = ready && drawing.data ? parseSvgViewBox(drawing.data) : null;
  const region = useMemo(() => {
    const xs = focus.points.map(p => p.x), ys = focus.points.map(p => p.y);
    const left = Math.max(0, Math.min(...xs) - 35), top = Math.max(0, Math.min(...ys) - 35);
    return { key: `${focus.id}/${attempt}`, x: left, y: top, width: Math.min(focus.page.width, Math.max(...xs) + 35) - left, height: Math.min(focus.page.height, Math.max(...ys) + 35) - top };
  }, [focus, attempt]);
  useAssistantSurface({ projectId: focus.projectId, priority: 28, label: `Schematic / ${focus.reference}`, details: JSON.stringify({ reference: focus.reference, value: focus.value, sheet: focus.sourcePath, sourceSha256: focus.sourceSha256, displayStatus: ready && displayed ? "verified saved component anchor highlighted on canvas" : "not displayed: source/preview verification pending or changed", limitation: "Saved symbol origins only; not ERC, PCB parity or semantic role verification." }) });
  const clear = () => useUiStore.getState().clearSchematicFocus();
  return <section className="fd-schematic-focus-view" aria-label={`Schematic component ${focus.reference}`} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); clear(); } }}>
    <header><div><strong>{focus.reference} · {focus.value}</strong><p>{focus.board ? `Board source: ${focus.board.sourceId} · ` : ""}Sheet: {focus.sheet?.hierarchyPath ?? "/"}{focus.sheet?.pageNumber ? ` · page ${focus.sheet.pageNumber}` : ""}</p><p>{ready ? "Saved symbol location · not an electrical check" : checking ? "Checking saved sheet and preview…" : "Source or preview changed or is unavailable. Highlight hidden; ask to locate this component again."}</p></div><Button variant="ghost" size="sm" disabled={!ready} onClick={() => setAttempt(n => n + 1)}>Focus again</Button><Button size="sm" onClick={clear}>Return to previous view</Button></header>
    {ready && box && drawing.data ? <SvgViewer svg={drawing.data} viewKey={focus.id} focusRegion={region} onRegionFocused={() => setDisplayed(true)} overlay={<div data-canvas-tools className="fd-schematic-focus-markers">{focus.points.map((p, i) => <div key={i} className="fd-schematic-focus-marker" role="img" aria-label={`${focus.reference} unit ${p.unit} saved origin at ${p.x}, ${p.y} mm`} style={{ left: `${(p.x - box.x) / box.width * 100}%`, top: `${(p.y - box.y) / box.height * 100}%` }}><span />{focus.reference}{focus.points.length > 1 ? ` · unit ${p.unit}` : ""}</div>)}</div>} /> : <div role="status" className="fd-schematic-focus-pending">{checking ? <Spinner /> : <Button onClick={() => { void source.refetch(); void drawing.refetch(); void sources.refetch(); setAttempt(n => n + 1); }}>Recheck saved files</Button>}</div>}
  </section>;
}
