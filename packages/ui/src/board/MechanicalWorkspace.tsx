import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { ImportedMechanicalModel, type MechanicalModelUnits } from "@fabdesk/protocol";
import { createModelImportSession, mechanicalModelFormat, useCoreClient, useProject, useProjectText } from "@fabdesk/client-core";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Dialog, EmptyState, LoadError, Spinner } from "../components/ui";
import { Icon } from "../components/Icon";
import { useUiStore } from "../stores/ui";
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
  const project = useProject(projectId);
  const [selected, setSelected] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const models = (project.data?.files ?? []).filter((file) => IMPORTED_MODEL.test(file.path)).sort((a, b) => b.mtime.localeCompare(a.mtime));
  const generated = project.data?.files.find((file) => /^exports\/enclosure\.stl$/i.test(file.path));
  const path = selected && project.data?.files.some((file) => file.path === selected) ? selected : models[0]?.path ?? generated?.path ?? null;
  const metadataPath = path && IMPORTED_MODEL.test(path) ? `${path.slice(0, path.lastIndexOf("/"))}/model.json` : null;
  const metadata = useProjectText(projectId, metadataPath);
  const model = useMemo(() => {
    if (!metadata.data) return null;
    try { const parsed = ImportedMechanicalModel.safeParse(JSON.parse(metadata.data)); return parsed.success && parsed.data.path === path ? parsed.data : null; }
    catch { return null; }
  }, [metadata.data, path]);
  const previewable = path && /\.(glb|stl|obj)$/i.test(path);
  if (project.isError) return <LoadError title="Could not load mechanical files" onRetry={() => void project.refetch()} />;
  if (!project.data) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return <div className="fd-mechanical-workspace">
    {generating ? <div className="fd-mechanical-generator"><div className="fd-mechanical-generator-heading"><Button size="sm" onClick={() => { if (generated) setSelected(generated.path); setGenerating(false); }}>{generated ? "View generated case" : "Back to canvas"}</Button><span>Generate from the saved PCB</span></div><EnclosurePanel key={projectId} /></div>
      : path ? <>
        {previewable ? <Suspense fallback={<div className="flex h-full items-center justify-center"><Spinner /></div>}><ModelCanvas key={`${projectId}:${path}`} projectId={projectId} path={path} /></Suspense> : <EmptyState title="STEP model saved"><p>The original is in this project. STEP preview and fit checks are not available in this canvas yet.</p><Button className="mt-4" onClick={() => useUiStore.getState().openProjectFile(path)}>Show saved file</Button></EmptyState>}
        <div className="fd-mechanical-selection"><Icon name="tool" width={18} height={18} /><div><strong>{model?.originalName ?? path.split("/").pop()}</strong><span>{model ? `${model.units === "file" ? "Units from file" : `Source units: ${model.units}`} · Placement not checked` : IMPORTED_MODEL.test(path) ? "Source units unconfirmed · Placement not checked" : "Generated case · Open generator to check alignment"}</span></div>
          {models.length + (generated ? 1 : 0) > 1 && <select aria-label="Choose enclosure model" value={path} onChange={(event) => setSelected(event.target.value)}>{models.map((file) => <option key={file.path} value={file.path}>{file.path.split("/").pop()} · {file.path.split("/")[2]?.slice(0, 5)}</option>)}{generated && <option value={generated.path}>Generated enclosure</option>}</select>}
        </div>
      </> : <div className="fd-mechanical-start"><Icon name="tool" width={52} height={52} /><h1>Add an enclosure</h1><p>Bring your existing model, or generate a case around this board.</p><div><Button variant="primary" onClick={() => setImportOpen(true)}><Icon name="folderOpen" width={17} height={17} />Import a model</Button><Button onClick={() => setGenerating(true)}>Generate from PCB</Button></div><span>STL, GLB, OBJ or STEP · Original files preserved</span></div>}
    {!generating && <div className="fd-mechanical-actions">{path && <Button size="sm" onClick={() => setImportOpen(true)}>Import model</Button>}{path && <Button size="sm" onClick={() => setGenerating(true)}>Generate / check case</Button>}<Button size="sm" variant="ghost" onClick={onAdvanced}>Advanced CAD</Button></div>}
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
      <input ref={input} type="file" accept=".stl,.glb,.obj,.step,.stp" className="sr-only" aria-label="Choose enclosure model file" disabled={busy} onChange={(event) => {
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
