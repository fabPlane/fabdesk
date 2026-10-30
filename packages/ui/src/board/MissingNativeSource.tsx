import { useEffect, useRef, useState } from "react";
import type { ProjectBoardSources } from "@fabdesk/protocol";
import { nativeSourceCandidates, useCore, useProject, type AssemblySceneSelection } from "@fabdesk/client-core";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { Icon } from "../components/Icon";
import { Button, EmptyState } from "../components/ui";
import { newChatDraftKey, useUiStore } from "../stores/ui";

/** Shared recovery: inspect known repository files, attach an import, or request a proposed design. */
export function MissingNativeSource({ projectId, kind, enabled, visible = true, directory = ".", selection, membership, name }: { projectId: string; kind: "pcb" | "schematic"; enabled: boolean; visible?: boolean; directory?: string; selection?: AssemblySceneSelection; membership?: ProjectBoardSources; name?: string }) {
  const { host } = useCore(), project = useProject(projectId);
  const [picking, setPicking] = useState(false), [error, setError] = useState<string | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const candidates = nativeSourceCandidates(project.data?.files ?? [], kind, directory, membership), label = kind === "pcb" ? "PCB" : "schematic";
  const source = selection ? membership?.sources.find(record => record.source.id === selection.sourceId)?.source : undefined;
  const surface = { projectId, label: `${name ?? "Board"} / Add ${label}`, priority: 15, details: JSON.stringify({ kind, directory, selection, source, possibleNativeFiles: candidates, candidatesAreNotMatchedSources: true, inventoryFailed: project.isError, instruction: "Inspect existing files and source provenance first. Verify the correct root sheet, referenced files, revision and shared-source ownership before linking or copying. Preserve existing native files; filenames and timestamps do not establish electrical parity. Generation must remain a proposed design for review." }) };
  useAssistantSurface(visible ? surface : null);
  const active = () => {
    const ui = useUiStore.getState(), current = ui.assemblyBoardByProject[projectId];
    return alive.current && ui.activeProjectId === projectId && (!selection || current?.sourceId === selection.sourceId && current.manifestSha256 === selection.manifestSha256 && current.instanceId === selection.instanceId);
  };
  const request = (action: "find" | "generate" | "import") => {
    if (!enabled || !active()) return;
    const target = name ? ` for ${name}` : " for this project";
    const question = action === "find" ? `Find the matching native ${label}${target}. Search the project files and source repository first, confirm which design belongs here, then show it on this canvas.` : action === "import" ? `Import the attached native ${label}${target}. Check the matching source, referenced sheets and dependencies, preserve existing files, and show the imported design here.` : `Help me create a proposed ${label}${target}. Reuse a matching existing design if available; otherwise explain the design and what needs review before applying it.`;
    askAboutSurface(surface, question);
  };
  const chooseFiles = async () => {
    if (!enabled || picking || !active()) return;
    setPicking(true); setError(null);
    try {
      const paths = await host.pickFile({ multiple: true, filters: [{ name: "KiCad design files", extensions: kind === "pcb" ? ["kicad_pcb", "kicad_pro", "kicad_sch"] : ["kicad_sch", "kicad_pro", "sch", "lib", "dcm"] }] });
      if (!paths.length || !active()) return;
      const ui = useUiStore.getState(), key = ui.activeThreadId ?? newChatDraftKey(projectId);
      for (const path of paths) if (!ui.attachments[key]?.some(file => file.path === path)) ui.addAttachment(key, { path, mime: "text/plain", label: path.split(/[\\/]/).at(-1) ?? path });
      request("import");
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (alive.current) setPicking(false); }
  };
  return <div className="fd-canvas-empty h-full" data-testid={`board-${kind}-missing-source`}><EmptyState title={`Add ${name ? "this board’s" : "a"} ${label}`} icon={<Icon name={kind === "pcb" ? "pcb" : "schematic"} width={42} height={42} />} action={<div className="fd-schematic-start-actions"><div className="flex flex-wrap items-center justify-center gap-2"><Button disabled={!enabled || picking} onClick={() => request("find")}><Icon name="search" width={16} height={16} />{candidates.length ? "Find matching source" : "Find with agent"}</Button><CanvasToolButton icon="folderOpen" label={picking ? "Choosing files…" : `Import ${label}`} variant="secondary" disabled={!enabled || picking} onClick={() => void chooseFiles()} /><CanvasToolButton icon="sparkles" label="Generate with agent" variant="secondary" disabled={!enabled || picking} onClick={() => request("generate")} /></div><p>Review the request in Ask fabPlane, then send when ready.</p></div>}>
    {candidates.length ? `${candidates.length} possible native ${candidates.length === 1 ? "file is" : "files are"} already in this source folder. Check which design belongs to this board before linking it.` : project.isError ? "The project file list could not be read. Retry or ask the agent to inspect the source." : `No linked native ${label} was found. Find an existing design, import your files or ask fabPlane to create one.`}
    {candidates.length > 0 && <details className="mt-4 text-left"><DisclosureSummary icon="folderOpen" label="Possible source files" badge={String(candidates.length)} variant="compact" /><div className="mt-2 flex max-h-48 flex-col gap-1 overflow-auto">{candidates.map(path => <Button key={path} variant="ghost" size="sm" disabled={!enabled || picking} className="justify-start break-all text-left" onClick={() => { if (active()) useUiStore.getState().openProjectFile(path); }}>{path}</Button>)}</div></details>}
    {project.isError && <Button size="sm" variant="ghost" onClick={() => void project.refetch()}>Retry source files</Button>}
  </EmptyState>{error && <p role="alert" className="text-center text-xs text-danger">{error}</p>}</div>;
}
