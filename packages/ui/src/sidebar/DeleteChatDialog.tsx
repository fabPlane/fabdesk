import { useState } from "react";
import type { Thread } from "@fabdesk/protocol";
import { useThreadMutations } from "@fabdesk/client-core";
import { Button, Dialog } from "../components/ui";
import { useUiStore } from "../stores/ui";

export function DeleteChatDialog({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const { remove } = useThreadMutations();
  const [error, setError] = useState<string | null>(null);
  const close = () => { if (!remove.isPending) onClose(); };
  const submit = async () => {
    if (remove.isPending) return;
    setError(null);
    try {
      await remove.mutateAsync(thread.id);
      const ui = useUiStore.getState();
      if (ui.activeThreadId === thread.id) ui.startNewChatInProject(thread.projectId);
      onClose();
      // Run after the dialog's focus trap and menu focus restoration have unmounted.
      requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>(".fd-composer textarea")?.focus());
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Could not delete chat. Try again."); }
  };
  return <Dialog open onClose={close} closeDisabled={remove.isPending} title="Delete chat?" className="!w-[420px]" fallbackFocus={() => document.querySelector<HTMLElement>(".fd-composer textarea")}>
    <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <p className="break-words text-sm text-muted">Delete <strong className="text-fg">{thread.title}</strong>? This cannot be undone.</p>
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" disabled={remove.isPending} onClick={close}>Cancel</Button>
        <Button type="submit" variant="danger" disabled={remove.isPending}>{remove.isPending ? "Deleting…" : "Delete"}</Button>
      </div>
    </form>
  </Dialog>;
}
