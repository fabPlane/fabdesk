import { useProjectExitGuard } from "../hooks/useProjectExitGuard";
import { useAssistantSurface } from "../chat/useAssistantSurface";
import { useEffect, useRef, useState } from "react";
import { Button, Dialog, EmptyState, LoadError, Spinner, Textarea } from "../components/ui";
import { useBoardCommentMutations, useBoardNotes, useCoreClient, useProject } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";
import { WorkspaceMenu } from "../layout/WorkspaceMenu";
import { Markdown } from "../chat/Markdown";
import { Icon } from "../components/Icon";

/** A project-wide document; an unfinished local draft survives switching tasks. */
export function NotesTab() {
  const projectId = useUiStore(s => s.activeProjectId), client = useCoreClient();
  const notes = useBoardNotes(projectId), project = useProject(projectId);
  const { writeNotes } = useBoardCommentMutations(projectId);
  const key = JSON.stringify([client.baseUrl, projectId]);
  const draft = useUiStore(s => s.notesDrafts[key]);
  const [preview, setPreview] = useState(false), [saving, setSaving] = useState(false), [saveError, setSaveError] = useState<string | null>(null);
  const [reviewSaved, setReviewSaved] = useState(false);
  const [discardFor, setDiscardFor] = useState<string | null>(null);
  useProjectExitGuard(projectId, saving ? "Notes are being saved. Wait for the save to finish." : null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const focusEditor = () => requestAnimationFrame(() => { if (useUiStore.getState().activeProjectId === projectId) editor.current?.focus(); });
  const saved = notes.data?.content ?? "", content = draft?.content ?? saved;
  const hasSavedNotes = project.data?.files.some(file => file.path === "NOTES.md") ?? false;
  const dirty = content !== saved, changedOutside = !saving && !!notes.data && !!draft && dirty && draft.base !== saved;
  const canSave = !!projectId && !!notes.data && dirty && !changedOutside && !saving && !notes.isFetching && !notes.isError;
  useAssistantSurface(projectId ? { projectId, label: "Project notes", priority: 10, details: JSON.stringify({ file: "NOTES.md", previewMode: preview, unsavedChanges: dirty, changedOutside, saving, discardConfirmationOpen: discardFor === key, ...(dirty ? { unsavedDraft: content.slice(0, 4000), draftTruncated: content.length > 4000 } : {}) }) } : null);
  useEffect(() => {
    if (!notes.data || saving) return;
    const current = useUiStore.getState().notesDrafts[key];
    if (current?.content === notes.data.content) useUiStore.getState().setNotesDraft(key, null);
  }, [key, notes.data?.content, draft?.content, saving]);

  const save = async () => {
    if (!canSave || useUiStore.getState().activeProjectId !== projectId) return;
    const submitted = content;
    setSaving(true); setSaveError(null);
    try {
      await writeNotes.mutateAsync(submitted);
      const latest = await notes.refetch();
      if (latest.isError) { setSaveError("Notes were saved, but could not be rechecked. Your local draft is kept."); return; }
      if (latest.data?.content !== submitted) { setSaveError("Saved notes changed again. Your draft is kept; review the latest file."); return; }
      const ui = useUiStore.getState(), current = ui.notesDrafts[key];
      if (current?.content === submitted) ui.setNotesDraft(key, null);
      else if (current) ui.setNotesDraft(key, { ...current, base: submitted });
      focusEditor();
    } catch (error) { setSaveError(error instanceof Error ? error.message : "Could not save project notes. Your draft is kept."); }
    finally { setSaving(false); }
  };

  if (!projectId) return <EmptyState title="Project notes">Choose a project for its decisions and open questions.</EmptyState>;
  if (notes.isError && !draft && !notes.data) return <LoadError title="Could not load project notes" onRetry={() => void notes.refetch()} />;
  if (notes.isLoading && !draft) return <div className="flex h-full items-center justify-center"><Spinner /></div>;
  return <div className="fd-project-notes" data-testid="board-notes" onKeyDown={event => {
    if (!event.shiftKey && !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void save(); }
  }}>
    <header><div><h1>Project notes</h1><p>Decisions, requirements and open questions shared across this project.</p></div>
      <div className="fd-notes-actions"><Button size="sm" variant="ghost" aria-pressed={preview || reviewSaved} onClick={() => { if (reviewSaved) setReviewSaved(false); else setPreview(!preview); }}>{reviewSaved ? "Return to draft" : preview ? "Edit notes" : "Preview"}</Button>
        <WorkspaceMenu label={<span aria-label="More notes tools"><Icon name="more" width={17} height={17} /></span>}>
          <button disabled={notes.isFetching || saving} onClick={() => void notes.refetch()}>Recheck saved notes</button>
          <button disabled={!dirty || saving || !notes.data || notes.isError || notes.isFetching} onClick={() => setDiscardFor(key)}>Discard unsaved draft…</button>
          <button disabled={!hasSavedNotes} onClick={() => useUiStore.getState().openProjectFile("NOTES.md")}>Show saved file</button>
          <div className="fd-menu-caption">Saved as NOTES.md. Markdown formatting is optional.</div>
        </WorkspaceMenu>
        <Button size="sm" variant="primary" disabled={!canSave} onClick={() => void save()}>{saving ? "Saving…" : !dirty && hasSavedNotes ? "Saved" : "Save notes"}</Button>
      </div>
    </header>
    {changedOutside && <div className="fd-notes-notice" role="alert"><p>Saved notes changed while you were editing. Your draft is kept.</p><Button size="sm" onClick={() => setReviewSaved(true)}>Review saved notes</Button><Button size="sm" onClick={() => { useUiStore.getState().setNotesDraft(key, null); setReviewSaved(false); setPreview(false); setSaveError(null); focusEditor(); }}>Use saved notes</Button><Button size="sm" onClick={() => { useUiStore.getState().setNotesDraft(key, { base: saved, content }); setReviewSaved(false); setPreview(false); setSaveError(null); focusEditor(); }}>Keep my draft</Button></div>}
    {notes.isError && <div className="fd-notes-notice" role="alert">Saved notes could not be refreshed. <Button size="sm" onClick={() => void notes.refetch()}>Retry</Button></div>}
    {saveError && <p className="fd-notes-notice" role="alert">{saveError}</p>}
    <section className="fd-notes-paper" aria-label={reviewSaved ? "Saved notes review" : preview ? "Project notes preview" : "Project notes editor"}>
      {preview || reviewSaved ? <div className="fd-notes-preview">{reviewSaved && <p className="mb-4 text-xs text-muted">Saved file · Your draft is kept</p>}{(reviewSaved ? saved : content).trim() ? <Markdown text={reviewSaved ? saved : content} /> : <p className="text-sm text-muted">{reviewSaved ? "The saved file is empty." : "Your notes preview will appear here."}</p>}</div> : <Textarea ref={editor} value={content} onChange={event => {
        const next = event.target.value;
        useUiStore.getState().setNotesDraft(key, next === saved ? null : { base: draft && dirty ? draft.base : saved, content: next });
        setSaveError(null);
      }} placeholder={"What should everyone working on this project know?\n\nWrite decisions, requirements, open questions or bring-up notes…"} aria-label="Project notes" />}
    </section>
    <Dialog open={discardFor === key} title="Discard unsaved notes?" onClose={() => { setDiscardFor(null); focusEditor(); }}>
      <p className="text-sm text-muted">Your saved NOTES.md file stays unchanged. The unsaved draft for this project will be removed.</p>
      <div className="mt-5 flex justify-end gap-2"><Button onClick={() => { setDiscardFor(null); focusEditor(); }}>Keep editing</Button><Button disabled={!dirty || saving || !notes.data || notes.isError || notes.isFetching} onClick={() => {
        if (discardFor !== key || useUiStore.getState().activeProjectId !== projectId || saving || !notes.data || notes.isError || notes.isFetching) return;
        useUiStore.getState().setNotesDraft(key, null); setDiscardFor(null); setReviewSaved(false); setPreview(false); setSaveError(null); focusEditor();
      }}>Discard draft</Button></div>
    </Dialog>
    <footer role="status">{dirty ? "Unsaved draft · Kept during navigation in this app session" : hasSavedNotes ? "Saved notes stay with this project" : "Notes will be saved with this project"}</footer>
  </div>;
}
