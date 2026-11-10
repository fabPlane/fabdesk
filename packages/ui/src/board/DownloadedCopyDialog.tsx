import type { ProjectDetail } from "@fabdesk/protocol";
import { Button, Dialog } from "../components/ui";
import { useUiStore } from "../stores/ui";

/** Explicit confirmation preserves the existing project's unfinished-edit guard. */
export function DownloadedCopyDialog({
  copy,
  onClose,
  onOpened,
}: {
  copy: ProjectDetail;
  onClose: () => void;
  onOpened: () => void;
}) {
  const activeId = useUiStore((s) => s.activeProjectId),
    blocks = useUiStore((s) => s.projectExitBlocks);
  const pending = Object.values(blocks).filter((b) => b.projectId === activeId);
  return (
    <Dialog open title="Open downloaded copy?" onClose={onClose} className="fd-share-dialog">
      <p>
        A separate copy of <strong>{copy.name}</strong> is saved in Projects. Opening it keeps the
        current project’s files and conversations. Running tasks continue there.
      </p>
      {pending.length > 0 && (
        <p role="alert">
          Finish your open edits before switching projects. The downloaded copy will stay in
          Projects.
        </p>
      )}
      <footer className="fd-share-footer">
        <Button variant="ghost" onClick={onClose}>
          Keep working
        </Button>
        <Button
          variant="primary"
          disabled={pending.length > 0}
          onClick={() => {
            const ui = useUiStore.getState();
            if (ui.activeProjectId && ui.activeProjectId !== copy.id && !ui.closeProject()) return;
            if (ui.setActiveProject(copy.id)) {
              ui.setBoardOpen(true);
              onOpened();
            }
          }}
        >
          Open downloaded copy
        </Button>
      </footer>
    </Dialog>
  );
}
