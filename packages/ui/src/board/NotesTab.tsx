import { useEffect, useState } from "react";
import { Button, EmptyState, LoadError, Spinner, Textarea } from "../components/ui";
import { useBoardCommentMutations, useBoardNotes } from "@fabdesk/client-core";
import { useUiStore } from "../stores/ui";

export function NotesTab() {
  const projectId = useUiStore((s) => s.activeProjectId);
  const notes = useBoardNotes(projectId);
  const { writeNotes } = useBoardCommentMutations(projectId);
  const [draft, setDraft] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (notes.data && !loaded) {
      setDraft(notes.data.content);
      setLoaded(true);
    }
  }, [notes.data, loaded]);

  useEffect(() => {
    setLoaded(false);
  }, [projectId]);

  if (!projectId)
    return (
      <div className="fd-canvas-empty h-full">
        <EmptyState title="Shared notes">Pick a project to edit its NOTES.md sheet.</EmptyState>
      </div>
    );
  if (notes.isError) return <LoadError title="Could not load NOTES.md" onRetry={() => void notes.refetch()} />;
  if (notes.isLoading && !loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const dirty = draft !== (notes.data?.content ?? "");
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="board-notes">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.09em] text-muted">NOTES.md</span>
        <span className="text-[11px] text-muted">Shared sheet for this board. Git-tracked.</span>
        <Button
          className="ml-auto"
          size="sm"
          variant="primary"
          disabled={!dirty || writeNotes.isPending}
          onClick={() => void writeNotes.mutateAsync(draft)}
        >
          {writeNotes.isPending ? "Saving..." : dirty ? "Save" : "Saved"}
        </Button>
      </div>
      <Textarea
        className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-3 font-mono text-[12.5px] leading-relaxed"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Notes the whole board shares — decisions, open questions, how to bring it up."
        aria-label="Board notes"
      />
      {writeNotes.isError && (
        <div role="alert" className="border-t border-border px-3 py-2 text-xs text-danger">
          {writeNotes.error instanceof Error ? writeNotes.error.message : "Could not save NOTES.md"}
        </div>
      )}
    </div>
  );
}
