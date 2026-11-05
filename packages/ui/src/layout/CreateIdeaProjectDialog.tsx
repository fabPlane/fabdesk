import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useCore } from "@fabdesk/client-core";
import type { ProjectDetail } from "@fabdesk/protocol";
import { Button, Dialog, Input } from "../components/ui";
import { Icon } from "../components/Icon";
import { ErrorNotice } from "../components/ErrorNotice";
import { newChatDraftKey, useUiStore } from "../stores/ui";

/** Promotion preserves the same id, thread, relative attachments and original saved sketches. */
export function CreateIdeaProjectDialog({ project, threadId, onClose }: { project: ProjectDetail; threadId: string | null; onClose: () => void }) {
  const { client, host } = useCore(), qc = useQueryClient();
  const requested = project.manifest.ideaDraft?.requestedBuild;
  const [name, setName] = useState(project.name === "Untitled idea" ? "" : project.name);
  const [directory, setDirectory] = useState<string | null>(null);
  const [pending, setPending] = useState(false), [picking, setPicking] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState(false);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(client.baseUrl).hostname);
  const sketches = project.files.filter(file => /^sketches\//.test(file.path));
  const pick = async () => {
    if (!host.pickDirectory) return;
    setPicking(true);
    try { const chosen = await host.pickDirectory(); if (chosen) setDirectory(chosen); }
    catch (failure) { setError(failure); }
    finally { setPicking(false); }
  };
  const submit = async () => {
    if (!name.trim() || pending || picking || created) return;
    setPending(true); setError(null);
    try {
      const promoted = await client.promoteIdeaDraft(project.id, name.trim(), directory ?? undefined);
      setCreated(true);
      // Do not unmount the dialog midway through continuation when the query updates.
      qc.setQueryData(["project", project.id], promoted);
      void qc.invalidateQueries({ queryKey: ["projects"] });
      if (requested && threadId) {
        try {
          await client.sendMessage(threadId, { content: requested, attachments: [] });
          void qc.invalidateQueries({ queryKey: ["messages", threadId] });
        } catch (failure) {
          // Never retry automatically or create a second project. Keep the exact request
          // beside any text the user already wrote so it can be reviewed and sent normally.
          const ui = useUiStore.getState(), key = threadId ?? newChatDraftKey(project.id);
          const existing = ui.drafts[key] ?? "";
          ui.setDraft(key, existing.trim() ? `${existing}\n\n${requested}` : requested);
          setError(failure);
          return;
        }
      }
      onClose();
      useUiStore.getState().focusComposer();
    } catch (failure) { setError(failure); }
    finally { setPending(false); }
  };
  return <Dialog open onClose={() => { if (!pending && !picking) onClose(); }} closeDisabled={pending || picking} title={created ? pending ? "Starting your request…" : "Project created" : "Create a project to build this"} className="!w-[560px]">
    <p className="mb-6 text-sm leading-6 text-muted">{created ? pending ? "Your project is created. Continuing your request in this conversation…" : "Your conversation and sketches are kept. The request could not start; it is back in your composer to review and send." : "Your conversation and sketches stay with it. You can keep exploring without creating a project."}</p>
    {!created && <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-5">
      <label className="flex flex-col gap-2 text-sm font-medium">Project name<Input autoFocus required maxLength={80} value={name} placeholder="e.g. USB sensor" onChange={event => setName(event.target.value)} disabled={pending} /></label>
      <div className="space-y-2"><span className="text-sm font-medium">Save location</span><div className="flex items-center gap-3 rounded-xl border border-border p-3"><Icon name="folder" /><span className="min-w-0 flex-1 break-all text-sm">{directory ?? "Default projects folder"}</span>{local && host.pickDirectory && <Button type="button" size="sm" disabled={pending || picking} onClick={() => void pick()}>{picking ? "Choosing…" : "Choose…"}</Button>}</div><p className="text-xs leading-5 text-muted">A new project folder will be created here. Your draft files move with it.</p></div>
      <div className="rounded-xl bg-panel-2 p-3 text-sm text-muted"><Icon name="compose" className="mr-2 inline" />{sketches.length} saved {sketches.length === 1 ? "reference" : "references"} · All conversations</div>
      {requested && <div className="rounded-xl border border-border p-3 text-sm"><strong className="font-medium">Continue after setup</strong><p className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap text-muted">{requested}</p></div>}
      {error != null && <ErrorNotice error={error} />}
      <div className="flex flex-wrap justify-end gap-3 border-t border-border pt-4"><Button type="button" disabled={pending || picking} onClick={onClose}>Keep exploring</Button><Button type="submit" variant="primary" disabled={!name.trim() || pending || picking}>{pending ? "Creating project…" : requested && threadId ? "Create project & generate" : "Create project"}</Button></div>
    </form>}
    {created && <>{error != null && <ErrorNotice error={error} />}<div className="mt-5 flex justify-end"><Button variant="primary" disabled={pending} onClick={onClose}>Return to project</Button></div></>}
  </Dialog>;
}
