import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCore, sortImportedBoards, importedBoardLabel, isBackupBoard, type ImportedBoardSort } from "@fabdesk/client-core";
import { parsePublicGitHubUrl } from "@fabdesk/protocol";
import { Select, Button, Dialog, Input } from "../components/ui";
import { Icon } from "../components/Icon";
import { ErrorNotice } from "../components/ErrorNotice";
import { useUiStore } from "../stores/ui";

/** Mounted only while open, so canceled names and locations never leak into the next project. */
export function CreateProjectDialog({ onClose, onCreated, initialMode = "create" }: { onClose: () => void; onCreated: (id: string) => void; initialMode?: "create" | "github" }) {
  const { client, host } = useCore();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"create" | "github">(initialMode);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [url, setUrl] = useState("");
  const [directory, setDirectory] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<{ id: string; boards: string[] } | null>(null);
  const [sort, setSort] = useState<ImportedBoardSort>("version");
  const abort = useRef<AbortController | null>(null);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname);
  const canPick = local && !!host.pickDirectory;

  const destinationQuery = useQuery({
    queryKey: ["github-import-destination", client.baseUrl, name.trim(), directory],
    queryFn: () => client.importGitHubDestination(name.trim(), directory ?? undefined),
    enabled: mode === "github" && !!name.trim() && !result,
    retry: false,
    gcTime: 0,
  });
  // A previous name/location or a failed refresh must never authorize this import.
  const destination = !destinationQuery.isFetching && !destinationQuery.isError ? destinationQuery.data : undefined;

  const close = () => { if (!pending && !picking) onClose(); };
  const pick = async () => {
    if (!canPick || !host.pickDirectory) return;
    setPicking(true); setError(null);
    try { const path = await host.pickDirectory(); if (path) setDirectory(path); }
    catch (e) { setError(e); }
    finally { setPicking(false); }
  };
  const finish = async (id: string, boardAvailable = true) => {
    await qc.invalidateQueries({ queryKey: ["projects"] });
    onCreated(id);
    if (mode === "create") useUiStore.getState().focusComposer();
    else if (!boardAvailable) {
      useUiStore.getState().setBoardTab("files");
      useUiStore.getState().setAssistantOpen(false);
    }
  };
  const submit = async () => {
    if (!name.trim() || pending || picking) return;
    setPending(true); setError(null);
    try {
      if (mode === "create") {
        const project = await client.createProject(name.trim(), directory ?? undefined);
        await finish(project.id);
      } else {
        if (!url.trim() || !destination || destination.exists) return;
        abort.current = new AbortController();
        const imported = await client.importGitHub(url.trim(), name.trim(), directory ?? undefined, abort.current.signal);
        await qc.invalidateQueries({ queryKey: ["projects"] });
        if (imported.boards.length !== 1 || !imported.adoptedBoard) setResult({ id: imported.project.id, boards: imported.boards });
        else await finish(imported.project.id);
      }
    } catch (e) {
      setError(abort.current?.signal.aborted ? "Import canceled. No project was added." : e);
    } finally { abort.current = null; setPending(false); }
  };
  const adopt = async (path: string) => {
    if (!result || pending) return;
    setPending(true); setError(null);
    try { await client.adoptImportedBoard(result.id, path); await finish(result.id); }
    catch (e) { setError(e); }
    finally { setPending(false); }
  };
  return <Dialog open onClose={close} closeDisabled={pending || picking} title={result ? "Project imported" : mode === "github" ? "Import from GitHub" : "Create project"} className="!w-[520px]">
    {!result && <div className="mb-5 flex gap-2" role="tablist" aria-label="Project setup">
      <Button type="button" role="tab" aria-selected={mode === "create"} {...(mode === "create" ? { variant: "primary" as const } : {})} disabled={pending} onClick={() => { setMode("create"); setError(null); }}>New project</Button>
      <Button type="button" role="tab" aria-selected={mode === "github"} {...(mode === "github" ? { variant: "primary" as const } : {})} disabled={pending} onClick={() => { setMode("github"); setError(null); }}>Import from GitHub</Button>
    </div>}
    {result ? <div className="space-y-4">
      {result.boards.length === 0 ? <p className="text-sm leading-6 text-muted">Project imported. No KiCad board was found. You can add one later.</p> : <>
        <p className="text-sm text-muted">Choose the board to open. Other versions stay in Files.</p>
        <label className="flex items-center justify-between gap-2 text-sm">Sort boards<Select aria-label="Sort imported boards" value={sort} disabled={pending} onChange={event => setSort(event.target.value as ImportedBoardSort)} className="rounded-md border border-border bg-panel px-2 py-2"><option value="version">Version · newest first</option><option value="path">Path · A–Z</option></Select></label>
        <div className="max-h-[45vh] space-y-2 overflow-y-auto" role="group" aria-label="KiCad boards">
          {[false, true].map(backup => {
            const paths = sortImportedBoards(result.boards.filter(path => isBackupBoard(path) === backup), sort);
            const choices = paths.map(path => <Button key={path} type="button" disabled={pending} className="!h-auto min-h-12 w-full !whitespace-normal !items-start !flex-col !gap-1 !py-3 text-left" title={path} onClick={() => void adopt(path)}><strong>{importedBoardLabel(path)}</strong><span className="min-w-0 w-full break-all text-xs font-normal leading-5 text-muted">{path}</span></Button>);
            return backup ? paths.length > 0 && <details key="backups"><summary className="cursor-pointer py-3 text-sm text-muted">Backups & archives · {paths.length}</summary><div className="space-y-2">{choices}</div></details> : <div key="boards" className="space-y-2">{choices}</div>;
          })}
        </div>
      </>}
      {pending && <p role="status" className="text-sm text-muted">Opening board…</p>}
      {error != null && <ErrorNotice error={error} />}
      <div className="flex justify-end"><Button type="button" disabled={pending} onClick={() => void finish(result.id, false)}>{result.boards.length ? "Open without board" : "Open project"}</Button></div>
    </div> : <form className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      {mode === "github" && <label className="flex flex-col gap-2 text-[13px] font-medium">Public GitHub URL
        <Input autoFocus type="url" required value={url} disabled={pending} onChange={(e) => {
          const next = e.target.value; setUrl(next);
          if (!nameTouched) {
            try { setName(parsePublicGitHubUrl(next).repo); }
            catch { setName(""); }
          }
        }} placeholder="https://github.com/owner/repo" className="h-11" />
        <span className="text-xs font-normal leading-5 text-muted">Public repositories only. The Git origin stays connected.</span>
      </label>}
      <label className="flex flex-col gap-2 text-[13px] font-medium">Project name
        <div className="relative"><Icon name="folder" className="pointer-events-none absolute left-3 top-3 text-muted" />
          <Input autoFocus={mode === "create"} required maxLength={80} value={name} disabled={pending} onChange={(e) => { setNameTouched(true); setName(e.target.value); }} placeholder="My project" className="h-11 pl-10" data-testid="create-project-name" />
        </div>
      </label>
      <div className="flex flex-col gap-2"><span className="text-[13px] font-medium">Project location</span>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-bg/40 p-4">
          <div className="flex min-w-0 flex-1 items-start gap-3"><Icon name="folder" className="mt-0.5 shrink-0 text-muted" />
            <div className="min-w-0 text-[13px]"><div className="break-all font-medium">{directory ?? "Default projects folder"}</div>
              {mode === "create" && <p className="mt-1 text-xs leading-5 text-muted">A new folder will be created here for your project.</p>}</div></div>
          {canPick ? <div className="flex flex-wrap gap-2"><Button type="button" disabled={pending || picking} onClick={() => void pick()}>{picking ? "Choosing…" : directory ? "Change folder" : "Choose folder…"}</Button>
            {directory && <Button type="button" disabled={pending || picking} onClick={() => setDirectory(null)}>Use default</Button>}</div> : <p className="text-xs leading-5 text-muted">{local ? "Folder selection is available in the desktop app." : "The project will be created on the connected computer."}</p>}
        </div>
      </div>
      {mode === "github" && name.trim() && <div className="rounded-xl bg-panel-2/70 px-3 py-2 text-xs leading-5" aria-live="polite">
        {destinationQuery.isError ? <>
          <p className="font-medium text-danger">Couldn’t check the project location.</p>
          <p>Your import details are kept. Retry, or choose another name or location.</p>
          <ErrorNotice error={destinationQuery.error} />
          <Button type="button" size="sm" disabled={pending || picking} onClick={() => void destinationQuery.refetch()}>Retry location check</Button>
        </> : <>Destination: <span className="break-all font-medium">{destination?.path ?? "Checking…"}</span>{destination?.exists && <span className="block text-danger">This folder already exists. Choose another name or location.</span>}</>}
      </div>}
      {pending && mode === "github" && <p role="status" className="text-xs text-muted">Cloning repository and checking for KiCad boards…</p>}
      {error != null && <ErrorNotice error={error} />}
      <div className="sticky bottom-0 z-10 flex flex-wrap justify-end gap-3 border-t border-border bg-panel py-3">
        <Button type="button" disabled={picking} onClick={() => { if (pending && abort.current) abort.current.abort(); else close(); }}>{pending && mode === "github" ? "Cancel import" : "Cancel"}</Button>
        <Button type="submit" variant="primary" disabled={!name.trim() || pending || picking || (mode === "github" && (!url.trim() || !destination || destination.exists))}>{pending ? mode === "github" ? "Importing…" : "Creating…" : mode === "github" ? "Import project" : "Create project"}</Button>
      </div>
    </form>}
  </Dialog>;
}
