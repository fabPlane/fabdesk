import { jobIsActive, newChatDraftKey, projectJobs, useCoreClient, useJobs, useProject, useRunsStore, useThreads } from "@fabdesk/client-core";
import { Button, Dialog } from "../components/ui";
import { useUiStore } from "../stores/ui";

export function CloseProjectDialog() {
  const projectId = useUiStore(s => s.activeProjectId), open = useUiStore(s => s.projectExitRequested);
  const blocks = useUiStore(s => s.projectExitBlocks), notes = useUiStore(s => s.notesDrafts), drafts = useUiStore(s => s.drafts), attachments = useUiStore(s => s.attachments);
  const client = useCoreClient(), project = useProject(projectId), threads = useThreads({ ...(projectId ? { projectId } : {}) });
  const jobs = useJobs(open && !!projectId, projectId ?? undefined), live = useRunsStore(s => s.jobs), runs = useRunsStore(s => s.runsByThread);
  const pending = Object.values(blocks).filter(block => block.projectId === projectId);
  const keys = new Set([newChatDraftKey(projectId), ...(threads.data ?? []).filter(thread => thread.projectId === projectId).map(thread => thread.id)]);
  const chatDrafts = [...keys].filter(key => drafts[key]?.trim() || attachments[key]?.length).length;
  const note = notes[JSON.stringify([client.baseUrl, projectId])], noteDraft = note && note.content !== note.base;
  const active = projectId ? projectJobs(projectId, jobs.data ?? [], live, client.baseUrl).filter(jobIsActive).length + (threads.data ?? []).filter(thread => thread.projectId === projectId && runs[thread.id]).length : 0;
  const cancel = () => useUiStore.getState().requestProjectClose(false);
  return <Dialog open={open && !!projectId} onClose={cancel} title={pending.length ? "Finish your open edit first" : "Close project?"} className="!w-[520px]">
    <p className="text-sm leading-6">{pending.length ? "Resolve these edits before returning to Home:" : <>Close <strong>{project.data?.name ?? "this project"}</strong> and return to Home to open another project.</>}</p>
    {pending.length > 0 && <ul className="my-4 list-disc space-y-2 pl-5 text-sm">{pending.map((block, index) => <li key={index}>{block.message}</li>)}</ul>}
    {!pending.length && <div className="my-4 space-y-2 text-sm text-muted"><p>Saved files and conversations stay with this project.</p>{(chatDrafts > 0 || noteDraft) && <p>{chatDrafts > 0 ? `${chatDrafts} unsent conversation ${chatDrafts === 1 ? "draft is" : "drafts are"} kept. ` : ""}{noteDraft ? "Your unsaved Notes draft stays available while this app remains open; it has not been saved to NOTES.md." : ""}</p>}<p>{active ? `${active} running ${active === 1 ? "task continues" : "tasks continue"} on the connected core. Reopen this project to see progress and results.` : "Any running tasks continue on the connected core. Reopen the project to review its activity."}</p></div>}
    <div className="mt-5 flex justify-end gap-2"><Button onClick={cancel}>{pending.length ? "Return to edit" : "Keep working"}</Button>{!pending.length && <Button variant="primary" onClick={() => useUiStore.getState().closeProject()}>Close project</Button>}</div>
  </Dialog>;
}
