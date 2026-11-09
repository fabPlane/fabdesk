import { ShareProjectDialog } from "./ShareProjectDialog";
import { useState } from "react";
import { buildZip } from "@fabdesk/board-art";
import { errorPayload, readOutputSelection, reviewPackageFiles, useBoardSources, useCoreClient, useProject, useProjectShareSettings, type ReviewPackageOptions } from "@fabdesk/client-core";
import { Button, Dialog, Spinner } from "../components/ui";
import { ErrorNotice } from "../components/ErrorNotice";
import { DisclosureSummary } from "../components/DisclosureSummary";
import { CanvasToolButton } from "../components/CanvasToolButton";
import { Icon } from "../components/Icon";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { askAboutSurface, useAssistantSurface } from "../chat/useAssistantSurface";
import { useUiStore } from "../stores/ui";

type View = "share" | "sync" | "history";
const TITLES: Record<View, string> = { share: "Share for review", sync: "Repository review", history: "Saved versions" };

/** Local sharing is a real file download; repository requests stay unsent until the user reviews them. */
export function HostedReviewTools({ projectId, shareButton = false }: { projectId: string; shareButton?: boolean }) {
  const [sharing, setSharing] = useState(false);
  const shareSettings = useProjectShareSettings(projectId, shareButton);
  const signInRequired = shareSettings.isError && errorPayload(shareSettings.error).code === "cloud_signed_out";
  const visibility = shareSettings.isError ? "unavailable" : shareSettings.data?.visibility ?? "loading";
  const visibilityLabel = visibility === "private" ? "Private" : (visibility === "unlisted" || visibility === "restricted") ? "Shared" : visibility === "loading" ? "Checking…" : "Unavailable";
  const visibilityDetail = visibility === "private" ? "Private project. Only you can access it. Click to share." : visibility === "unlisted" ? "Anyone with the link can view the published snapshot. Click to manage access." : visibility === "restricted" ? "Only invited viewers can access the published snapshot. Click to manage access." : visibility === "loading" ? "Checking project visibility…" : "Visibility could not be checked. Open sharing settings to retry.";
  const [view, setView] = useState<View | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null);
  const [options, setOptions] = useState<ReviewPackageOptions>({ outputs: true, sources: false, notes: true, checks: true });
  const client = useCoreClient(), project = useProject(projectId), sources = useBoardSources(projectId);
  const ready = !!sources.data && !sources.isFetching && !sources.isError && !!project.data && !project.isFetching && !project.isError;
  const files = sources.data ? reviewPackageFiles(project.data?.files ?? [], sources.data, options) : [];
  const surface = { projectId, label: view ? TITLES[view] : "Review", priority: 50, details: JSON.stringify({ view, selectedFileCount: files.length, options, projectSourceMode: sources.data?.mode, sourceCheckPending: !ready }) };
  useAssistantSurface(view ? surface : null);
  const close = () => { if (!busy) { setView(null); setError(null); } };
  const openLocal = (tab: "files" | "diff") => {
    if (busy || useUiStore.getState().activeProjectId !== projectId) return;
    close(); useUiStore.getState().setBoardTab(tab);
  };
  const ask = (question: string) => { askAboutSurface(surface, question); close(); };
  const download = async () => {
    if (!ready || busy || !sources.data || !files.length || useUiStore.getState().activeProjectId !== projectId) return;
    const captured = sources.data;
    setBusy(true); setError(null);
    try {
      const entries = await readOutputSelection(client, projectId, files), after = await client.inspectBoardSources(projectId);
      if (after.mode !== captured.mode || after.manifestSha256 !== captured.manifestSha256) throw new Error("Board ownership changed while preparing the package. Review the sources and try again.");
      const index = { project: project.data?.name, createdAt: new Date().toISOString(), purpose: "Review of selected saved files; not a validated manufacturing release or a complete dependency archive.", sourceMode: captured.mode, manifestSha256: captured.manifestSha256, files: entries.map(entry => entry.name), options };
      entries.push({ name: "review-package.json", data: new TextEncoder().encode(JSON.stringify(index, null, 2) + "\n") });
      const bytes = buildZip(entries);
      if (useUiStore.getState().activeProjectId !== projectId) return;
      const url = URL.createObjectURL(new Blob([Uint8Array.from(bytes).buffer], { type: "application/zip" })), link = document.createElement("a");
      link.href = url; link.download = `fabPlane-${(project.data?.name ?? "project").replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 60)}-review.zip`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (failure) { setError(failure); } finally { setBusy(false); }
  };
  return <>
    {shareButton ? <Button
      size="sm"
      variant="secondary"
      className="fd-project-share-button"
      title={signInRequired ? "Share this project" : visibilityDetail}
      data-visibility={visibility}
      aria-label={signInRequired ? "Share project" : `Sharing settings · ${visibilityLabel}`}
      onClick={() => setSharing(true)}
    >
      {visibility === "loading" ? <Spinner /> : <Icon name={visibility === "unavailable" && !signInRequired ? "warning" : "share"} width={17} height={17} />}
      {(visibility === "unlisted" || visibility === "restricted") ? "Shared" : "Share"}
    </Button> : <WorkspaceMenu className="fd-review-publishing" label={<><span>Review tools</span><Icon name="chevronDown" width={14} height={14} /></>}>
      <button onClick={() => setView("share")}>Download review package…</button><button onClick={() => setView("sync")}>Review repository changes…</button><button onClick={() => setView("history")}>Saved versions…</button>
    </WorkspaceMenu>}
    {sharing && <ShareProjectDialog projectId={projectId} onClose={() => setSharing(false)} onDownload={() => { setSharing(false); setView("share"); }} />}
    <Dialog open={view !== null} onClose={close} closeDisabled={busy} title={view ? TITLES[view] : "Review tools"} className="fd-review-integration-dialog" headerActions={<CanvasToolButton icon="sparkles" label="Ask about this review" disabled={busy} onClick={() => ask("Help me review this project and prepare a clear handoff. Check the saved sources and outputs before recommending what to share.")} />}>

      {view === "share" ? <section className="fd-review-package"><h3>Download a review package</h3><p>Choose the saved files to include in one ZIP. Share the downloaded file using your usual channel.</p>
        <fieldset disabled={busy}>{([{ key: "outputs", label: "Saved images, videos, models and exports" }, { key: "sources", label: "Native design sources and local libraries" }, { key: "notes", label: "Project notes and comments" }, { key: "checks", label: "Saved checks and revision comparisons" }] as const).map(item => <label key={item.key}><input type="checkbox" checked={options[item.key]} onChange={event => setOptions(previous => ({ ...previous, [item.key]: event.target.checked }))} />{item.label}</label>)}</fieldset>
        <p role="status">{ready ? `${files.length} saved files · Project definition included` : project.isError || sources.isError ? "Project files or board ownership could not be checked." : "Checking project files and board ownership…"}</p>
        <details><DisclosureSummary icon="folderOpen" label="Included files" badge={files.length} variant="compact" /><ul className="fd-review-package-files">{files.map(file => <li key={file.path}>{file.path}</li>)}</ul></details>
        <p>External libraries and model dependencies may be missing. Packaging files does not establish freshness, compatibility or validation.</p>
        {(project.isError || sources.isError) && <Button size="sm" onClick={() => { void project.refetch(); void sources.refetch(); }}>Retry file check</Button>}
        <Button variant="primary" disabled={!ready || busy || !files.length} onClick={() => void download()}>{busy ? <><Spinner />Preparing ZIP…</> : "Download review ZIP"}</Button>
      </section> : view === "sync" ? <section><h3>Review Git changes with the agent</h3><p>Inspect local changes, the repository and its remote before deciding what to commit, push or pull. These actions prepare a question in the chat.</p><div className="fd-review-integration-actions"><Button onClick={() => ask("Review this project’s Git changes and remote. Summarize the exact files and commits that would be published, and prepare a push plan for my review without pushing yet.")}>Prepare a push review</Button><Button onClick={() => ask("Inspect this project’s Git remote and incoming changes. Explain additions, replacements and conflicts, and propose a safe pull plan without applying it yet.")}>Review incoming changes</Button></div></section> : <section><h3>Compare saved versions</h3><p>Changes shows saved comparison points and available Git revisions for each board source. Compare versions before deciding what to recover.</p><Button onClick={() => openLocal("diff")}>Open saved comparisons</Button><p>Position tools offer a limited revert for eligible moves. Board resizing is awaiting integration.</p></section>}
      {error != null && <ErrorNotice error={error} />}
      <div className="fd-review-integration-actions"><Button size="sm" disabled={busy} onClick={() => openLocal("diff")}>Review local changes</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => openLocal("files")}>Browse project files</Button></div>
    </Dialog>
  </>;
}
