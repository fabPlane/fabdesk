import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { ImportedMechanicalModel, type MechanicalModelUnits } from "@fabdesk/protocol";
import { useBoardModelRevision, useBoardSources, createModelImportSession, mechanicalModelFormat, useEnclosureSourceRevision, useCoreClient, useProject, useProjectText } from "@fabdesk/client-core";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, EmptyState, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
import { AssemblyOverview } from "../layout/AssemblyOverview";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { EnclosurePanel } from "./EnclosurePanel";

const ModelCanvas = lazy(() => import("./ModelCanvas"));
const IMPORTED_MODEL = /^mechanical\/imports\/[^/]+\/[^/]+\.(stl|glb|obj|step|stp)$/i;

/** Imported originals and generated cases share the same mechanical workspace. */
export function MechanicalWorkspace({ onAdvanced }: { onAdvanced: () => void }) {
  const projectId = useUiStore((s) => s.activeProjectId);
  if (!projectId) return <EmptyState title="Choose a project for its enclosure" />;
  return <ProjectMechanical key={projectId} projectId={projectId} onAdvanced={onAdvanced} />;
}

function ProjectMechanical({ projectId, onAdvanced }: { projectId: string; onAdvanced: () => void }) {
  const project = useProject(projectId), sources = useBoardSources(projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const models = (project.data?.files ?? []).filter((file) => IMPORTED_MODEL.test(file.path)).sort((a, b) => b.mtime.localeCompare(a.mtime));
  const hasPcb = project.data?.files.some((file) => file.path === "board.kicad_pcb") ?? false;
  const assembly = sources.data?.mode === "assembly";
  const canGenerate = hasPcb && !assembly && !sources.isPending && !sources.isFetching && !sources.isError;
  const generationNote = sources.isError ? "Board sources could not be checked. Retry before generating." : sources.isPending || sources.isFetching ? "Checking board sources…" : assembly ? "Generation for a multi-board assembly is not available here yet. You can import an existing enclosure." : !hasPcb ? "Add a PCB in Board before generating a case." : "Start from this board’s saved outline and mounting features.";
  const referencePath = !assembly && hasPcb && !sources.isPending && !sources.isError && project.data?.files.some(file => file.path === "renders/board.glb") ? "renders/board.glb" : null;
  const referenceRevision = useBoardModelRevision(projectId, !!referencePath);
  const referenceLabel = referenceRevision.isFetching ? "Checking saved board model…" : referenceRevision.isError ? "Board model source check unavailable" : referenceRevision.data === "source-changed" ? "PCB changed · Saved board model is older" : referenceRevision.data === "artifact-changed" ? "Board model changed · Source unverified" : referenceRevision.data === "source-unchanged" ? "Saved board reference · Fit not checked" : "Saved board reference · Source and fit unverified";
  const generated = project.data?.files.find((file) => /^exports\/enclosure\.stl$/i.test(file.path));
  const path = selected && project.data?.files.some((file) => file.path === selected) ? selected : models[0]?.path ?? generated?.path ?? null;
  const metadataPath = path && IMPORTED_MODEL.test(path) ? `${path.slice(0, path.lastIndexOf("/"))}/model.json` : null;
  const metadata = useProjectText(projectId, metadataPath);
  const model = useMemo(() => {
    if (!metadata.data) return null;
    try { const parsed = ImportedMechanicalModel.safeParse(JSON.parse(metadata.data)); return parsed.success && parsed.data.path === path ? parsed.data : null; }
    catch { return null; }
  }, [metadata.data, path]);
  const caseSource = useEnclosureSourceRevision(projectId, !!path && path === generated?.path);
  const caseChanged = path === generated?.path && caseSource.data === "changed";
  const previewable = path && /\.(glb|stl|obj)$/i.test(path);
  if (project.isError) return <LoadError title="Could not load mechanical files" onRetry={() => void project.refetch()} />;
  if (!project.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return <div className="fd-mechanical-workspace">
    {generating ? <div className="fd-mechanical-generator" data-reference={!!referencePath}>
      {referencePath && <div className="fd-mechanical-generator-reference"><Suspense fallback={<Spinner />}><ModelCanvas projectId={projectId} path={referencePath} /></Suspense><p className="fd-mechanical-reference-note" data-warning={["source-changed", "artifact-changed"].includes(referenceRevision.data ?? "")}>{referenceLabel}</p></div>}
      <div className="fd-mechanical-generator-controls"><div className="fd-mechanical-generator-heading"><Button size="sm" onClick={() => { if (generated) setSelected(generated.path); setGenerating(false); }}>{generated ? "View generated case" : "Back to canvas"}</Button><span>Generate from the saved PCB</span></div><fieldset className="min-w-0" disabled={!canGenerate}><legend className="sr-only">Generated enclosure controls</legend><EnclosurePanel key={projectId} /></fieldset>{!canGenerate && <p className="fd-mechanical-generator-status" role="status">{generationNote}</p>}</div>
    </div>
      : path ? <>
        {previewable ? <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}><ModelCanvas key={`${projectId}:${path}`} projectId={projectId} path={path} /></Suspense> : <EmptyState title="STEP model saved"><p>The original is in this project. STEP preview and fit checks are not available in this canvas yet.</p><Button className="mt-4" onClick={() => useUiStore.getState().openProjectFile(path)}>Show saved file</Button></EmptyState>}
        <div className="fd-mechanical-selection" data-stale={caseChanged}><Icon name="tool" width={18} height={18} /><div><strong>{model?.originalName ?? path.split("/").pop()}</strong><span>{model ? `${model.units === "file" ? "Units from file" : `Source units: ${model.units}`} · Placement not checked` : IMPORTED_MODEL.test(path) ? "Source units unconfirmed · Placement not checked" : caseChanged ? "PCB changed · Review or regenerate this case" : caseSource.data === "missing-pcb" ? "PCB source missing · Check before using this case" : caseSource.isError ? "Could not verify source · Open generator to check" : "Generated case · Open generator to check alignment"}</span></div>
          {models.length + (generated ? 1 : 0) > 1 && <select aria-label="Choose enclosure model" value={path} onChange={(event) => setSelected(event.target.value)}>{models.map((file) => <option key={file.path} value={file.path}>{file.path.split("/").pop()} · {file.path.split("/")[2]?.slice(0, 5)}</option>)}{generated && <option value={generated.path}>Generated enclosure</option>}</select>}
        </div>
      </> : <div className="fd-mechanical-add-flow" data-reference={!!referencePath || assembly}>
        {assembly && sources.data && <div className="fd-mechanical-assembly-reference"><AssemblyOverview projectId={projectId} name={project.data.name} data={sources.data} checking={sources.isFetching} failed={sources.isError} onRetry={() => void sources.refetch()} /></div>}
        {referencePath && <><Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}><ModelCanvas projectId={projectId} path={referencePath} /></Suspense><p className="fd-mechanical-reference-note" data-warning={["source-changed", "artifact-changed"].includes(referenceRevision.data ?? "")}>{referenceLabel}</p></>}
        <section className="fd-mechanical-add-card" aria-label="Add enclosure">
          <header><h1>Add enclosure</h1><WorkspaceMenu className="fd-mechanical-more" label={<span aria-label="More mechanical tools"><Icon name="more" width={18} height={18} /></span>}><button onClick={onAdvanced}>Advanced CAD</button></WorkspaceMenu></header>
          <p>Use a case you already have, or start from your board.</p>
          <button className="fd-mechanical-choice" onClick={() => setImportOpen(true)}><Icon name="cube" width={25} height={25} /><span><strong>Import 3D model</strong><small>Use your existing case or mechanical part</small></span><Icon name="chevronRight" width={18} height={18} /></button>
          <button className="fd-mechanical-choice" disabled={!canGenerate} title={generationNote} onClick={() => { if (canGenerate) setGenerating(true); }}><Icon name="sparkles" width={25} height={25} /><span><strong>Generate enclosure</strong><small>{canGenerate ? "Start from this board" : assembly ? "Requires a single-board project" : hasPcb ? "Check board sources first" : "Add a PCB to get started"}</small></span><Icon name="chevronRight" width={18} height={18} /></button>
          {!canGenerate && <p role="status" className="fd-mechanical-generation-note">{generationNote}{sources.isError && <Button size="sm" variant="ghost" onClick={() => void sources.refetch()}>Retry source check</Button>}</p>}
          <details className="fd-mechanical-formats"><summary>STL, GLB, OBJ, STEP · Formats and units</summary><p>STL and OBJ need confirmed units. GLB uses metres. STEP originals are kept with their file units; STEP preview is not available here yet. Importing keeps the original and does not verify enclosure fit.</p></details>
        </section>
      </div>}
    {!generating && path && <div className="fd-mechanical-actions"><WorkspaceMenu className="fd-mechanical-more" label={<><span>Enclosure tools</span><Icon name="chevronDown" width={14} height={14} /></>}><button onClick={() => setImportOpen(true)}>Import another model</button><button disabled={!canGenerate} title={generationNote} onClick={() => { if (canGenerate) setGenerating(true); }}>{path === generated?.path ? "Review generated case" : "Generate a case from PCB"}</button><button onClick={onAdvanced}>Advanced CAD</button></WorkspaceMenu></div>}
    {importOpen && <ModelImportDialog projectId={projectId} onClose={() => setImportOpen(false)} onSaved={(path) => { if (useUiStore.getState().activeProjectId === projectId) { setSelected(path); setGenerating(false); setImportOpen(false); } }} />}
  </div>;
}

function ModelImportDialog({ projectId, onClose, onSaved }: { projectId: string; onClose: () => void; onSaved: (path: string) => void }) {
  const client = useCoreClient(), qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [units, setUnits] = useState<MechanicalModelUnits | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useMemo(() => createModelImportSession({ projectId, client }), [projectId, client, file]);
  const format = file ? mechanicalModelFormat(file.name) : null;
  const save = async () => {
    if (!file || !units || busy) return;
    setBusy(true); setError(null);
    try {
      const model = await session.save(file, file.name, units);
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
      void qc.invalidateQueries({ queryKey: ["projects"] });
      onSaved(model.path);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not import the model. Retry with the same file."); }
    finally { setBusy(false); }
  };
  return <Dialog open title="Import an enclosure model" onClose={() => { if (!busy) onClose(); }}>
    <div className="fd-model-import" onKeyDown={(event) => { if (event.ctrlKey || event.metaKey) { event.stopPropagation(); if (event.key === "Enter") event.preventDefault(); } }}>
      <p>Your original file stays in this project. Importing does not change the PCB or certify enclosure fit.</p>
      <input ref={input} type="file" accept=".stl,.glb,.obj,.step,.stp" hidden aria-label="Choose enclosure model file" disabled={busy} onChange={(event) => {
        const next = event.target.files?.[0] ?? null;
        setFile(next); setError(null);
        const kind = next ? mechanicalModelFormat(next.name) : null;
        setUnits(kind === "glb" ? "m" : kind === "step" || kind === "stp" ? "file" : "");
      }} />
      <Button disabled={busy} onClick={() => input.current?.click()}><Icon name="folderOpen" width={18} height={18} />{file ? "Choose another file" : "Choose model"}</Button>
      {file && <div className="fd-model-import-file"><strong>{file.name}</strong><span>{(file.size / 1024 / 1024).toFixed(2)} MB · {format?.toUpperCase() ?? "Unsupported format"}</span></div>}
      {file && format && <label>Source units<select aria-label="Source model units" value={units} disabled={busy || format === "glb" || format === "step" || format === "stp"} onChange={(event) => setUnits(event.target.value as MechanicalModelUnits)}><option value="">Choose the units used by your model</option><option value="mm">Millimetres (mm)</option><option value="cm">Centimetres (cm)</option><option value="m">Metres (m)</option><option value="in">Inches (in)</option>{(format === "step" || format === "stp") && <option value="file">Defined in the STEP file</option>}</select><span>{format === "glb" ? "GLB uses metres. The model is shown at its saved scale." : format === "step" || format === "stp" ? "STEP retains its own units. Canvas preview is not supported yet." : "STL and OBJ do not define units. Confirm these before importing."}</span></label>}
      {error && <p role="alert" className="text-danger">{error}</p>}
      <div className="flex justify-end gap-2"><Button disabled={busy} variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !file || !format || !units} onClick={() => void save()}>{busy ? "Saving original…" : "Import model"}</Button></div>
    </div>
  </Dialog>;
}
